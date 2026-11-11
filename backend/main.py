import os
import ssl
import json
import time
import asyncio
from datetime import datetime, timedelta
from typing import Optional, List

import jwt
import bcrypt
import pymysql
import pymysql.cursors
import paho.mqtt.client as mqtt
from dotenv import load_dotenv
from fastapi import FastAPI, Depends, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel, Field

if __package__:
    from .telegram_notifier import send_telegram_alert
else:
    from telegram_notifier import send_telegram_alert

# Đọc biến môi trường từ file .env (Mục 4.5)
load_dotenv()

MQTT_BROKER = os.getenv("MQTT_BROKER_URL", "")
MQTT_PORT = int(os.getenv("MQTT_BROKER_PORT", 8883))
MQTT_USER = os.getenv("MQTT_USERNAME", "")
MQTT_PASS = os.getenv("MQTT_PASSWORD", "")

# Thông tin kết nối Aiven MySQL
DB_HOST = os.getenv("DB_HOST", "")
DB_PORT = int(os.getenv("DB_PORT", 3306))
DB_USER = os.getenv("DB_USER", "avnadmin")
DB_PASSWORD = os.getenv("DB_PASSWORD", "")
DB_NAME = os.getenv("DB_NAME", "defaultdb")
SCHEMA_PATH = "./database/schema.sql"

JWT_SECRET = os.getenv("JWT_SECRET_KEY", "secret_key_nhom13")
JWT_ALGO = os.getenv("JWT_ALGORITHM", "HS256")

app = FastAPI(title="IoT Air Quality MIS Backend (Aiven MySQL) - Nhom 13", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

security = HTTPBearer()

# =========================================================================
# 1. KẾT NỐI AIVEN MYSQL & TỰ ĐỘNG KHỞI TẠO BẢNG + DỮ LIỆU MẪU
# =========================================================================
def get_db():
    return pymysql.connect(
        host=DB_HOST,
        port=DB_PORT,
        user=DB_USER,
        password=DB_PASSWORD,
        database=DB_NAME,
        cursorclass=pymysql.cursors.DictCursor,
        autocommit=False,
        ssl={" fake_flag_to_enable_tls": True} # Aiven MySQL yêu cầu kết nối SSL
    )

def log_audit(user_id: Optional[int], action: str, target: str, details: str, ip: str = "127.0.0.1"):
    """Ghi Audit Log lên Aiven MySQL (Mục 4.5)"""
    try:
        conn = get_db()
        with conn.cursor() as cursor:
            cursor.execute(
                "INSERT INTO audit_logs (user_id, action, target_entity, details, ip_address) VALUES (%s, %s, %s, %s, %s)",
                (user_id, action, target, details, ip)
            )
        conn.commit()
        conn.close()
    except Exception as e:
        print(f"[AUDIT ERROR] {e}")

# =========================================================================
# 2. LUỒNG MQTT WORKER CHẠY NGẦM (NHẬN TELEMETRY, STATUS, ACK)
# =========================================================================
mqtt_client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
last_saved_cache = {}
last_retention_cleanup = {}

async def send_telegram_notifications(notifications):
    await asyncio.gather(*(send_telegram_alert(*notification) for notification in notifications))

def create_threshold_alert(cursor, notifications, device, alert_type, severity, metric_name, current_value, threshold_value, unit):
    if current_value < threshold_value:
        cursor.execute(
            """UPDATE alerts SET status = 'RESOLVED', resolve_note = 'Chi so da tro lai muc an toan'
               WHERE device_id = %s AND alert_type = %s AND status IN ('NEW', 'ACKNOWLEDGED')""",
            (device["id"], alert_type)
        )
        return

    cursor.execute(
        """SELECT id FROM alerts
           WHERE device_id = %s AND alert_type = %s
             AND status IN ('NEW', 'ACKNOWLEDGED')
           LIMIT 1""",
        (device["id"], alert_type)
    )
    if cursor.fetchone():
        return

    message = (
        f"{metric_name} vuot nguong "
        f"({current_value} {unit} >= {threshold_value} {unit})"
    )
    cursor.execute(
        """INSERT INTO alerts (device_id, alert_type, severity, message, measured_value, threshold_value)
           VALUES (%s, %s, %s, %s, %s, %s)""",
        (device["id"], alert_type, severity, message, current_value, threshold_value)
    )
    notifications.append(
        (device["device_code"], metric_name, current_value, threshold_value, unit)
    )
    print(f"[ALERT] {device['device_code']}: {alert_type} threshold exceeded")

def on_connect(client, userdata, flags, reason_code, properties):
    if reason_code == 0:
        print(f"[MQTT BACKEND] Da ket noi toi EMQX Broker ({MQTT_BROKER})!")
        client.subscribe("iot_nhom13/+/telemetry", qos=1)
        client.subscribe("iot_nhom13/+/status", qos=1)
        client.subscribe("iot_nhom13/+/ack", qos=1)
    else:
        print(f"[MQTT BACKEND] Ket noi that bai, ma loi: {reason_code}")

def on_message(client, userdata, msg):
    topic = msg.topic
    telegram_notifications = []
    try:
        payload = json.loads(msg.payload.decode("utf-8"))
    except Exception as e:
        print(f"[MQTT ERROR] Ban tin JSON khong hop le tren topic {topic}: {e}")
        return

    try:
        conn = get_db()
        with conn.cursor() as cursor:
            # --- XỬ LÝ 1: BẢN TIN DỮ LIỆU CẢM BIẾN (TELEMETRY) ---
            if topic.endswith("/telemetry"):
                device_code = payload.get("device_code")
                secret_token = payload.get("secret_token")

                cursor.execute("SELECT * FROM devices WHERE device_code = %s", (device_code,))
                device = cursor.fetchone()

                if not device:
                    print(f"[SECURITY] Tu choi thiet bi la: {device_code}")
                    conn.close()
                    return

                if device["secret_token"] != secret_token:
                    print(f"[SECURITY] Sai secret_token tu thiet bi {device_code}!")
                    conn.close()
                    log_audit(None, "INVALID_DEVICE_TOKEN", f"DEVICE:{device_code}", "Thiet bi gui sai secret_token")
                    return

                if device["lifecycle_status"] in ("DECOMMISSIONED", "MAINTENANCE"):
                    print(f"[LIFECYCLE] Tu choi nhan du lieu vi {device_code} dang o trang thai {device['lifecycle_status']}")
                    conn.close()
                    log_audit(None, "REJECTED_TELEMETRY", f"DEVICE:{device_code}", f"Tu choi du lieu do trang thai {device['lifecycle_status']}")
                    return

                metrics = payload.get("metrics", {})
                temp = float(metrics.get("temperature", {}).get("value", 0.0))
                hum = float(metrics.get("humidity", {}).get("value", 0.0))
                eco2 = int(metrics.get("eco2", {}).get("value", 400))
                tvoc = int(metrics.get("tvoc", {}).get("value", 0))
                fan_state = 1 if payload.get("actuator_state", {}).get("fan_relay") == "ON" else 0

                if not (-10.0 <= temp <= 80.0 and 0.0 <= hum <= 100.0 and 0 <= eco2 <= 30000):
                    print(f"[VALIDATION] Du lieu bat thuong bi tu choi: temp={temp}, hum={hum}, eco2={eco2}")
                    conn.close()
                    return

                now_ts = time.time()
                prev = last_saved_cache.get(device_code)

                should_save_db = False
                if not prev:
                    should_save_db = True
                elif (
                    abs(temp - prev["temp"]) >= 0.2 or
                    abs(hum - prev["hum"]) >= 1.0 or
                    abs(eco2 - prev["eco2"]) >= 15 or
                    fan_state != prev["fan"] or
                    (now_ts - prev["time"]) >= 60
                ):
                    should_save_db = True

                if should_save_db:
                    cursor.execute(
                        """INSERT INTO telemetry_logs (device_id, temperature, humidity, eco2, tvoc, fan_state)
                           VALUES (%s, %s, %s, %s, %s, %s)""",
                        (device["id"], temp, hum, eco2, tvoc, fan_state)
                    )
                    if now_ts - last_retention_cleanup.get(device["id"], 0) >= 50:
                        cursor.execute(
                            """DELETE FROM telemetry_logs
                               WHERE device_id = %s AND id NOT IN (
                                   SELECT id FROM (
                                       SELECT id FROM telemetry_logs WHERE device_id = %s ORDER BY id DESC LIMIT 5000
                                   ) AS keep_rows
                               )""",
                            (device["id"], device["id"])
                        )
                        last_retention_cleanup[device["id"]] = now_ts

                    print(f"[AIVEN SAVED] {device_code}: Temp={temp}C, Hum={hum}%, eCO2={eco2}ppm (Da luu DB)")
                else:
                    print(f"[SKIPPED DB] {device_code}: Du lieu khong doi ({temp}C, {eco2}ppm) -> Bo qua ghi DB de tiet kiem Aiven")

                new_lifecycle = "ACTIVE" if device["lifecycle_status"] in ("REGISTERED", "PROVISIONED", "OFFLINE") else device["lifecycle_status"]
                cursor.execute(
                    "UPDATE devices SET is_online = 1, lifecycle_status = %s, last_seen_at = NOW() WHERE id = %s",
                    (new_lifecycle, device["id"])
                )

                create_threshold_alert(
                    cursor, telegram_notifications, device, "HIGH_ECO2", "CRITICAL",
                    "eCO2", eco2, device["eco2_threshold"], "ppm"
                )
                create_threshold_alert(
                    cursor, telegram_notifications, device, "HIGH_TVOC", "WARNING",
                    "TVOC", tvoc, device["tvoc_threshold"], "ppb"
                )
                create_threshold_alert(
                    cursor, telegram_notifications, device, "HIGH_TEMP", "WARNING",
                    "Nhiệt độ", temp, device["temp_threshold"], "°C"
                )

                conn.commit()
                if should_save_db:
                    last_saved_cache[device_code] = {
                        "temp": temp, "hum": hum, "eco2": eco2, "fan": fan_state, "time": now_ts
                    }

            # --- XỬ LÝ 2: BẢN TIN TRẠNG THÁI ONLINE / OFFLINE (LWT) ---
            elif topic.endswith("/status"):
                device_code = payload.get("device_code")
                status_str = payload.get("status", "OFFLINE")
                is_online = 1 if status_str == "ONLINE" else 0
                fw_ver = payload.get("firmware_version", "v1.0.0")

                cursor.execute("SELECT * FROM devices WHERE device_code = %s", (device_code,))
                device = cursor.fetchone()
                if device and device["lifecycle_status"] != "DECOMMISSIONED":
                    new_lifecycle = (
                        "MAINTENANCE"
                        if device["lifecycle_status"] == "MAINTENANCE"
                        else "ACTIVE" if is_online else "OFFLINE"
                    )
                    cursor.execute(
                        "UPDATE devices SET is_online = %s, lifecycle_status = %s, firmware_version = %s, last_seen_at = NOW() WHERE id = %s",
                        (is_online, new_lifecycle, fw_ver, device["id"])
                    )
                    if not is_online and device["is_online"]:
                        cursor.execute(
                            """INSERT INTO alerts (device_id, alert_type, severity, message, measured_value, threshold_value)
                               VALUES (%s, 'DEVICE_OFFLINE', 'WARNING', %s, 0, 0)""",
                            (device["id"], f"Thiet bi {device_code} mat ket noi dot ngot (LWT Offline)")
                        )
                    conn.commit()
                    print(f"[DEVICE STATUS] {device_code} chuyen sang trang thai: {status_str}")

            # --- XỬ LÝ 3: BẢN TIN XÁC NHẬN LỆNH ĐIỀU KHIỂN (ACK) ---
            elif topic.endswith("/ack"):
                cmd_code = payload.get("cmd_code")
                ack_status = payload.get("status", "SUCCESS")
                ack_msg = payload.get("message", "")
                device_code = payload.get("device_code")
                cursor.execute(
                    "UPDATE command_logs SET status = %s, ack_message = %s, acked_at = NOW() WHERE cmd_code = %s",
                    (ack_status, ack_msg, cmd_code)
                )
                if device_code:
                    cursor.execute(
                        """UPDATE devices
                           SET is_online = 1,
                               lifecycle_status = CASE
                                   WHEN lifecycle_status IN ('REGISTERED', 'PROVISIONED', 'OFFLINE') THEN 'ACTIVE'
                                   ELSE lifecycle_status
                               END,
                               last_seen_at = NOW()
                           WHERE device_code = %s AND lifecycle_status != 'DECOMMISSIONED'""",
                        (device_code,)
                    )
                conn.commit()
                print(f"[COMMAND ACK] Lenh {cmd_code} da duoc ESP32 xac nhan: {ack_status} ({ack_msg})")

        conn.close()
        if telegram_notifications:
            asyncio.run(send_telegram_notifications(telegram_notifications))
    except Exception as e:
        print(f"[DB WORKER ERROR] {e}")

def start_mqtt_worker():
    if not MQTT_BROKER:
        print("[WARN] Chua cau hinh MQTT_BROKER_URL trong file .env!")
        return
    mqtt_client.username_pw_set(MQTT_USER, MQTT_PASS)
    mqtt_client.tls_set(cert_reqs=ssl.CERT_NONE)
    mqtt_client.tls_insecure_set(True)
    mqtt_client.on_connect = on_connect
    mqtt_client.on_message = on_message
    try:
        mqtt_client.connect(MQTT_BROKER, MQTT_PORT, 60)
        mqtt_client.loop_start()
    except Exception as e:
        print(f"[MQTT ERROR] Khong the ket noi EMQX: {e}")

def mark_stale_devices_offline():
    conn = get_db()
    try:
        with conn.cursor() as cursor:
            cursor.execute(
                """SELECT id, device_code, lifecycle_status
                   FROM devices
                   WHERE is_online = 1
                     AND lifecycle_status != 'DECOMMISSIONED'
                     AND (last_seen_at IS NULL OR last_seen_at < DATE_SUB(NOW(), INTERVAL 30 SECOND))"""
            )
            stale_devices = cursor.fetchall()

            for device in stale_devices:
                cursor.execute(
                    """UPDATE devices
                       SET is_online = 0,
                           lifecycle_status = CASE
                               WHEN lifecycle_status = 'ACTIVE' THEN 'OFFLINE'
                               ELSE lifecycle_status
                           END
                       WHERE id = %s AND is_online = 1
                         AND (last_seen_at IS NULL OR last_seen_at < DATE_SUB(NOW(), INTERVAL 30 SECOND))""",
                    (device["id"],)
                )
                if cursor.rowcount:
                    cursor.execute(
                        """INSERT INTO alerts (device_id, alert_type, severity, message, measured_value, threshold_value)
                           VALUES (%s, 'DEVICE_OFFLINE', 'WARNING', %s, 0, 0)""",
                        (device["id"], f"Thiet bi {device['device_code']} khong gui MQTT trong hon 30 giay")
                    )
                    print(f"[WATCHDOG] {device['device_code']} offline: no MQTT message for over 30 seconds")

        conn.commit()
    finally:
        conn.close()

async def monitor_device_heartbeats():
    while True:
        try:
            await asyncio.to_thread(mark_stale_devices_offline)
        except Exception as error:
            print(f"[WATCHDOG ERROR] Khong the kiem tra heartbeat thiet bi: {error}")
        await asyncio.sleep(5)

@app.on_event("startup")
def startup_event():
    # init_db()
    start_mqtt_worker()
    asyncio.create_task(monitor_device_heartbeats())

# =========================================================================
# 3. XÁC THỰC JWT & PHÂN QUYỀN RBAC 3 VAI TRÒ (Mục 4.4a & 4.5)
# =========================================================================
def get_current_user(credentials: HTTPAuthorizationCredentials = Depends(security)):
    token = credentials.credentials
    try:
        return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGO])
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token da het han, vui long dang nhap lai")
    except Exception:
        raise HTTPException(status_code=401, detail="Token khong hop le")

def require_roles(allowed_roles: List[str]):
    def role_checker(request: Request, user: dict = Depends(get_current_user)):
        if user["role"] not in allowed_roles:
            log_audit(user["user_id"], "UNAUTHORIZED_ACCESS", request.url.path, f"Role {user['role']} bi chan truy cap", request.client.host)
            raise HTTPException(status_code=403, detail=f"Quyen '{user['role']}' khong duoc phep thuc hien thao tac nay!")
        return user
    return role_checker

# =========================================================================
# 4. CÁC MODELS DỮ LIỆU ĐẦU VÀO
# =========================================================================
class LoginRequest(BaseModel):
    username: str
    password: str

class CommandRequest(BaseModel):
    target: str = "FAN_RELAY"
    action: str

class ConfigRequest(BaseModel):
    send_interval_ms: int = Field(ge=1000, le=60000)
    eco2_threshold: float
    temp_threshold: float
    tvoc_threshold: Optional[float] = None

class LifecycleRequest(BaseModel):
    lifecycle_status: str

class OnboardDeviceRequest(BaseModel):
    device_code: str
    device_name: str
    location: str

class AckAlertRequest(BaseModel):
    resolve_note: str = "Da kiem tra va xu ly"

# =========================================================================
# 5. CÁC API NGHIỆP VỤ (LƯU TRỰC TIẾP TRÊN AIVEN MYSQL)
# =========================================================================
@app.post("/api/auth/login")
def login(req: LoginRequest, request: Request):
    conn = get_db()
    with conn.cursor() as cursor:
        cursor.execute("SELECT * FROM users WHERE username = %s AND is_active = 1", (req.username,))
        user = cursor.fetchone()
    conn.close()

    if not user or not bcrypt.checkpw(req.password.encode("utf-8"), user["password_hash"].encode("utf-8")):
        log_audit(None, "LOGIN_FAILED", f"USER:{req.username}", "Sai ten dang nhap hoac mat khau", request.client.host)
        raise HTTPException(status_code=401, detail="Sai tai khoan hoac mat khau")

    token_payload = {
        "user_id": user["id"],
        "username": user["username"],
        "full_name": user["full_name"],
        "role": user["role"],
        "exp": datetime.utcnow() + timedelta(hours=12)
    }
    token = jwt.encode(token_payload, JWT_SECRET, algorithm=JWT_ALGO)
    log_audit(user["id"], "USER_LOGIN", f"USER:{user['username']}", f"Dang nhap thanh cong voi quyen {user['role']}", request.client.host)
    return {"access_token": token, "user": token_payload}

@app.get("/api/devices")
def list_devices(user: dict = Depends(get_current_user)):
    conn = get_db()
    with conn.cursor() as cursor:
        cursor.execute("SELECT * FROM devices ORDER BY id ASC")
        devices = cursor.fetchall()
    conn.close()
    return devices

@app.post("/api/devices/onboard")
def onboard_device(req: OnboardDeviceRequest, user: dict = Depends(require_roles(["ADMIN"]))):
    secret_token = f"sec_tok_{req.device_code.lower()}_{int(time.time())}"
    conn = get_db()
    try:
        with conn.cursor() as cursor:
            cursor.execute(
                """INSERT INTO devices (device_code, device_name, secret_token, location, owner_id, lifecycle_status)
                   VALUES (%s, %s, %s, %s, %s, 'PROVISIONED')""",
                (req.device_code, req.device_name, secret_token, req.location, user["user_id"])
            )
        conn.commit()
    except pymysql.IntegrityError:
        conn.close()
        raise HTTPException(status_code=400, detail="Ma thiet bi (device_code) da ton tai!")
    conn.close()
    log_audit(user["user_id"], "ONBOARD_DEVICE", f"DEVICE:{req.device_code}", "Dang ky va cap token cho thiet bi moi")
    return {"message": "Dang ky thiet bi thanh cong", "device_code": req.device_code, "secret_token": secret_token}

@app.put("/api/devices/{device_code}/lifecycle")
def change_device_lifecycle(device_code: str, req: LifecycleRequest, user: dict = Depends(require_roles(["ADMIN"]))):
    conn = get_db()
    is_online = 0 if req.lifecycle_status in ("DECOMMISSIONED", "OFFLINE") else 1
    with conn.cursor() as cursor:
        cursor.execute(
            "UPDATE devices SET lifecycle_status = %s, is_online = %s WHERE device_code = %s",
            (req.lifecycle_status, is_online, device_code)
        )
    conn.commit()
    conn.close()
    log_audit(user["user_id"], "CHANGE_LIFECYCLE", f"DEVICE:{device_code}", f"Chuyen trang thai sang {req.lifecycle_status}")
    return {"message": f"Da chuyen trang thai thiet bi {device_code} sang {req.lifecycle_status}"}

@app.get("/api/devices/{device_code}/telemetry")
def get_telemetry(device_code: str, limit: int = 30, user: dict = Depends(get_current_user)):
    conn = get_db()
    with conn.cursor() as cursor:
        cursor.execute(
            "SELECT id, lifecycle_status FROM devices WHERE device_code = %s",
            (device_code,)
        )
        device = cursor.fetchone()
        if not device:
            conn.close()
            raise HTTPException(status_code=404, detail="Khong tim thay thiet bi")
        if device["lifecycle_status"] in ("MAINTENANCE", "DECOMMISSIONED"):
            conn.close()
            return []
        cursor.execute(
            "SELECT * FROM telemetry_logs WHERE device_id = %s ORDER BY id DESC LIMIT %s",
            (device["id"], limit)
        )
        rows = cursor.fetchall()
    conn.close()
    return list(reversed(rows))

@app.post("/api/devices/{device_code}/command")
def send_command(device_code: str, req: CommandRequest, user: dict = Depends(require_roles(["ADMIN", "OPERATOR"]))):
    conn = get_db()
    with conn.cursor() as cursor:
        cursor.execute("SELECT * FROM devices WHERE device_code = %s", (device_code,))
        device = cursor.fetchone()
        if not device:
            conn.close()
            raise HTTPException(status_code=404, detail="Khong tim thay thiet bi")
        if device["lifecycle_status"] == "DECOMMISSIONED":
            conn.close()
            raise HTTPException(status_code=400, detail="Thiet bi da bi thu hoi (DECOMMISSIONED), khong the dieu khien!")

        cmd_code = f"CMD_{int(time.time() * 1000)}"
        payload = {
            "cmd_code": cmd_code,
            "target": req.target,
            "action": req.action,
            "timestamp": int(time.time())
        }
        mqtt_client.publish(f"iot_nhom13/{device_code}/command", json.dumps(payload), qos=1)

        cursor.execute(
            """INSERT INTO command_logs (cmd_code, device_id, issued_by, target_actuator, command_action, payload_json, status)
               VALUES (%s, %s, %s, %s, %s, %s, 'PENDING')""",
            (cmd_code, device["id"], user["user_id"], req.target, req.action, json.dumps(payload))
        )
    conn.commit()
    conn.close()
    log_audit(user["user_id"], "SEND_COMMAND", f"DEVICE:{device_code}", f"Gui lenh {req.action} toi {req.target} ({cmd_code})")
    return {"message": "Da gui lenh dieu khien, dang cho phan hoi ACK tu ESP32", "cmd_code": cmd_code}

@app.put("/api/devices/{device_code}/config")
def update_remote_config(device_code: str, req: ConfigRequest, user: dict = Depends(require_roles(["ADMIN", "OPERATOR"]))):
    conn = get_db()
    with conn.cursor() as cursor:
        cursor.execute("SELECT * FROM devices WHERE device_code = %s", (device_code,))
        device = cursor.fetchone()
        if not device:
            conn.close()
            raise HTTPException(status_code=404, detail="Khong tim thay thiet bi")

        cmd_code = f"CFG_{int(time.time() * 1000)}"
        tvoc_threshold = (
            req.tvoc_threshold
            if req.tvoc_threshold is not None
            else device["tvoc_threshold"]
        )
        payload = {
            "cmd_code": cmd_code,
            "send_interval_ms": req.send_interval_ms,
            "eco2_threshold": req.eco2_threshold,
            "tvoc_threshold": tvoc_threshold,
            "temp_threshold": req.temp_threshold
        }
        publish_info = mqtt_client.publish(
            f"iot_nhom13/{device_code}/config",
            json.dumps(payload),
            qos=1,
            retain=True
        )
        publish_succeeded = publish_info.rc == mqtt.MQTT_ERR_SUCCESS

        cursor.execute(
            "UPDATE devices SET send_interval_ms = %s, eco2_threshold = %s, temp_threshold = %s, tvoc_threshold = %s WHERE device_code = %s",
            (req.send_interval_ms, req.eco2_threshold, req.temp_threshold, tvoc_threshold, device_code)
        )
        cursor.execute(
            """INSERT INTO command_logs (cmd_code, device_id, issued_by, target_actuator, command_action, payload_json, status)
               VALUES (%s, %s, %s, 'REMOTE_CONFIG', 'UPDATE_CONFIG', %s, %s)""",
            (
                cmd_code, device["id"], user["user_id"], json.dumps(payload),
                "PENDING" if publish_succeeded else "FAILED"
            )
        )
    conn.commit()
    conn.close()
    log_audit(
        user["user_id"], "UPDATE_CONFIG", f"DEVICE:{device_code}",
        f"Cap nhat chu ky {req.send_interval_ms}ms, nguong eCO2 {req.eco2_threshold}ppm, "
        f"TVOC {tvoc_threshold}ppb, nhiet do {req.temp_threshold}C"
    )
    return {
        "message": (
            "Backend da luu cau hinh; MQTT da xep lenh retained de dong bo ESP32"
            if publish_succeeded
            else "Backend da luu cau hinh nhung MQTT chua gui duoc lenh; ESP32 chua duoc dong bo"
        ),
        "cmd_code": cmd_code,
        "device_sync_queued": publish_succeeded,
        "config": {
            "send_interval_ms": req.send_interval_ms,
            "eco2_threshold": req.eco2_threshold,
            "tvoc_threshold": tvoc_threshold,
            "temp_threshold": req.temp_threshold
        }
    }

@app.get("/api/commands")
def list_commands(user: dict = Depends(get_current_user)):
    conn = get_db()
    with conn.cursor() as cursor:
        cursor.execute(
            """SELECT c.*, u.username FROM command_logs c 
               LEFT JOIN users u ON c.issued_by = u.id 
               ORDER BY c.id DESC LIMIT 20"""
        )
        rows = cursor.fetchall()
    conn.close()
    return rows

@app.get("/api/alerts")
def list_alerts(user: dict = Depends(get_current_user)):
    conn = get_db()
    with conn.cursor() as cursor:
        cursor.execute("SELECT * FROM alerts ORDER BY id DESC LIMIT 30")
        rows = cursor.fetchall()
    conn.close()
    return rows

@app.put("/api/alerts/{alert_id}/acknowledge")
def acknowledge_alert(alert_id: int, req: AckAlertRequest, user: dict = Depends(require_roles(["ADMIN", "OPERATOR"]))):
    conn = get_db()
    with conn.cursor() as cursor:
        cursor.execute(
            "UPDATE alerts SET status = 'ACKNOWLEDGED', acknowledged_by = %s, acknowledged_at = NOW(), resolve_note = %s WHERE id = %s",
            (user["user_id"], req.resolve_note, alert_id)
        )
    conn.commit()
    conn.close()
    log_audit(user["user_id"], "ACK_ALERT", f"ALERT:{alert_id}", req.resolve_note)
    return {"message": "Da xac nhan xu ly canh bao"}

@app.get("/api/audit-logs")
def list_audit_logs(user: dict = Depends(require_roles(["ADMIN"]))):
    conn = get_db()
    with conn.cursor() as cursor:
        cursor.execute(
            """SELECT a.*, u.username FROM audit_logs a 
               LEFT JOIN users u ON a.user_id = u.id 
               ORDER BY a.id DESC LIMIT 40"""
        )
        rows = cursor.fetchall()
    conn.close()
    return rows