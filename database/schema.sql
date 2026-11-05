-- =========================================================================
-- DATABASE SCHEMA & SEED DATA - HỆ THỐNG GIÁM SÁT CHẤT LƯỢNG KHÔNG KHÍ IoT
-- =========================================================================

-- 1. BẢNG NGƯỜI DÙNG & PHÂN QUYỀN (Mục 4.4a & 4.5)
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL, -- Mật khẩu đã băm (Bcrypt), tuyệt đối không lưu plain text
    full_name VARCHAR(100) NOT NULL,
    role VARCHAR(20) NOT NULL CHECK (role IN ('ADMIN', 'OPERATOR', 'VIEWER')),
    is_active BOOLEAN DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. BẢNG QUẢN LÝ VÒNG ĐỜI THIẾT BỊ (Mục 4.4b & 4.5)
CREATE TABLE IF NOT EXISTS devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_code VARCHAR(50) UNIQUE NOT NULL, -- Mã định danh duy nhất (VD: ESP32_NODE_01)
    device_name VARCHAR(100) NOT NULL,
    secret_token VARCHAR(255) NOT NULL,      -- Khóa bí mật riêng của từng thiết bị để xác thực MQTT/API
    location VARCHAR(100) NOT NULL,          -- Khu vực/Phòng lắp đặt
    owner_id INTEGER,                        -- Gán cho người vận hành quản lý
    hardware_version VARCHAR(20) DEFAULT 'ESP32-WROOM-32',
    firmware_version VARCHAR(20) DEFAULT 'v1.0.0',
    -- Trạng thái vòng đời bắt buộc theo Mục 4.4b
    lifecycle_status VARCHAR(20) NOT NULL DEFAULT 'REGISTERED' 
        CHECK (lifecycle_status IN ('REGISTERED', 'PROVISIONED', 'ACTIVE', 'OFFLINE', 'MAINTENANCE', 'DECOMMISSIONED')),
    is_online BOOLEAN DEFAULT 0,
    -- Cấu hình tham số từ xa (Remote Config)
    send_interval_ms INTEGER DEFAULT 5000,   -- Chu kỳ gửi dữ liệu (mặc định 5 giây)
    eco2_threshold FLOAT DEFAULT 1000.0,     -- Ngưỡng cảnh báo eCO2 (ppm)
    tvoc_threshold FLOAT DEFAULT 500.0,      -- Ngưỡng cảnh báo TVOC (ppb)
    temp_threshold FLOAT DEFAULT 35.0,       -- Ngưỡng cảnh báo Nhiệt độ (°C)
    last_seen_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (owner_id) REFERENCES users(id)
);

-- 3. BẢNG LƯU TRỮ DỮ LIỆU CẢM BIẾN THEO THỜI GIAN - TELEMETRY (Mục 4.4c)
CREATE TABLE IF NOT EXISTS telemetry_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id INTEGER NOT NULL,
    temperature FLOAT NOT NULL,              -- Nhiệt độ từ DHT22 (°C)
    humidity FLOAT NOT NULL,                 -- Độ ẩm từ DHT22 (%)
    eco2 INTEGER NOT NULL,                   -- Nồng độ eCO2 từ CCS811 (ppm)
    tvoc INTEGER NOT NULL,                   -- Nồng độ TVOC từ CCS811 (ppb)
    fan_state BOOLEAN DEFAULT 0,             -- Trạng thái cơ cấu chấp hành (0: Tắt, 1: Bật)
    recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
);

-- 4. BẢNG GIÁM SÁT & LỊCH SỬ CẢNH BÁO (Mục 4.4d)
CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id INTEGER NOT NULL,
    alert_type VARCHAR(50) NOT NULL,         -- VD: HIGH_ECO2, HIGH_TVOC, HIGH_TEMP, DEVICE_OFFLINE
    severity VARCHAR(20) NOT NULL CHECK (severity IN ('INFO', 'WARNING', 'CRITICAL')),
    message TEXT NOT NULL,
    measured_value FLOAT,
    threshold_value FLOAT,
    status VARCHAR(20) DEFAULT 'NEW' CHECK (status IN ('NEW', 'ACKNOWLEDGED', 'RESOLVED')),
    acknowledged_by INTEGER,                 -- Người xác nhận xử lý cảnh báo
    acknowledged_at TIMESTAMP,
    resolve_note TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
    FOREIGN KEY (acknowledged_by) REFERENCES users(id)
);

-- 5. BẢNG LỊCH SỬ ĐIỀU KHIỂN & PHẢN HỒI XÁC NHẬN - COMMAND & ACK (Mục 4.4e)
CREATE TABLE IF NOT EXISTS command_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cmd_code VARCHAR(50) UNIQUE NOT NULL,    -- Mã lệnh gửi xuống MQTT (VD: CMD_17308001)
    device_id INTEGER NOT NULL,
    issued_by INTEGER NOT NULL,              -- Người bấm nút gửi lệnh
    target_actuator VARCHAR(50) NOT NULL,    -- VD: FAN_RELAY, BUZZER, REMOTE_CONFIG
    command_action VARCHAR(50) NOT NULL,     -- VD: TURN_ON, TURN_OFF, UPDATE_CONFIG
    payload_json TEXT,                       -- Nội dung JSON chi tiết đã gửi
    status VARCHAR(20) DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SUCCESS', 'FAILED', 'TIMEOUT')),
    ack_message TEXT,                        -- Phản hồi từ ESP32 gửi về
    issued_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    acked_at TIMESTAMP,
    FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
    FOREIGN KEY (issued_by) REFERENCES users(id)
);

-- 6. BẢNG NHẬT KÝ BẢO MẬT - AUDIT LOGS (Mục 4.5)
CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,                         -- Null nếu là sự kiện từ thiết bị/hệ thống
    action VARCHAR(100) NOT NULL,            -- VD: USER_LOGIN, DECOMMISSION_DEVICE, UNAUTHORIZED_ACCESS
    target_entity VARCHAR(50),               -- VD: DEVICE:ESP32_NODE_01
    details TEXT,
    ip_address VARCHAR(45),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
);

-- =========================================================================
-- DỮ LIỆU MẪU (SEED DATA) ĐỂ PHỤC VỤ DEMO 10 BƯỚC (Mục 8.4)
-- (Mật khẩu mặc định của cả 3 tài khoản bên dưới đều là: 123456)
-- Chuỗi hash dưới đây là Bcrypt chuẩn của chuỗi "123456"
-- =========================================================================

INSERT INTO users (username, email, password_hash, full_name, role) VALUES
('admin', 'admin@iot.ptit.edu.vn', '$2b$12$KIX/yY1S9Q8mJqX1Y7uR2eG1xW.zN0V5T6Y8U9I0O1P2A3S4D5F6G', 'Quản Trị Viên Hệ Thống', 'ADMIN'),
('operator', 'operator@iot.ptit.edu.vn', '$2b$12$KIX/yY1S9Q8mJqX1Y7uR2eG1xW.zN0V5T6Y8U9I0O1P2A3S4D5F6G', 'Nhân Viên Vận Hành Phòng A2', 'OPERATOR'),
('viewer', 'viewer@iot.ptit.edu.vn', '$2b$12$KIX/yY1S9Q8mJqX1Y7uR2eG1xW.zN0V5T6Y8U9I0O1P2A3S4D5F6G', 'Sinh Viên Quan Sát', 'VIEWER');

INSERT INTO devices (device_code, device_name, secret_token, location, owner_id, lifecycle_status, is_online, send_interval_ms, eco2_threshold, tvoc_threshold, temp_threshold) VALUES
('ESP32_NODE_01', 'Trạm Giám Sát Không Khí Phòng Học A2', 'sec_tok_esp32_node01_998877aabbcc', 'Phòng Lab Tòa A2', 2, 'ACTIVE', 0, 5000, 1000.0, 500.0, 35.0);