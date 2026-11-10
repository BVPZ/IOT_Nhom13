#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include <DHT.h>
#include "Adafruit_CCS811.h"
#include <Preferences.h>
#include <time.h>
#include "secrets.h"

// =========================================================================
// 1. CẤU HÌNH WIFI & HIVEMQ/EMQX CLOUD
// =========================================================================
// Nằm trong file secrets.h (không commit lên GitHub)

// =========================================================================
// 2. ĐỊNH DANH THIẾT BỊ & TOPICS MQTT (Khớp với database/schema.sql)
// =========================================================================
const char* DEVICE_CODE   = "ESP32_NODE_01";
const char* FIRMWARE_VER  = "v1.0.0";

const char* TOPIC_TELEMETRY = "iot_nhom13/ESP32_NODE_01/telemetry";
const char* TOPIC_STATUS    = "iot_nhom13/ESP32_NODE_01/status";
const char* TOPIC_COMMAND   = "iot_nhom13/ESP32_NODE_01/command";
const char* TOPIC_ACK       = "iot_nhom13/ESP32_NODE_01/ack";
const char* TOPIC_CONFIG    = "iot_nhom13/ESP32_NODE_01/config";

// =========================================================================
// 3. CẤU HÌNH CHÂN CẮM PHẦN CỨNG
// =========================================================================
#define DHTPIN        4       // Chân OUT của DHT22 cắm vào D4 (GPIO 4)
#define DHTTYPE       DHT22
#define I2C_SDA       21      // Chân SDA của CCS811 cắm vào D21
#define I2C_SCL       22      // Chân SCL của CCS811 cắm vào D22
#define FAN_RELAY_PIN 25      // GPIO25 (D25) điều khiển module rơ-le (HIGH = bật)
#define ECO2_LED_PIN  16      // LED vàng/xanh: Cảnh báo eCO2 vượt ngưỡng
#define TVOC_LED_PIN  17      // LED đỏ: Cảnh báo TVOC vượt ngưỡng
#define BUZZER_PIN    19      // Còi báo động khi eCO2 hoặc TVOC vượt ngưỡng

DHT dht(DHTPIN, DHTTYPE);
Adafruit_CCS811 ccs;
WiFiClientSecure espClient;
PubSubClient mqttClient(espClient);
Preferences configPreferences;
bool configPreferencesReady = false;

// =========================================================================
// 4. BIẾN TRẠNG THÁI & THAM SỐ CẤU HÌNH TỪ XA (REMOTE CONFIG)
// =========================================================================
unsigned long sendIntervalMs    = 1000;   // Mặc định 1 giây gửi telemetry 1 lần
unsigned long heartbeatInterval = 30000;  // Mặc định 30 giây gửi heartbeat 1 lần
unsigned long lastTelemetryTime = 0;
unsigned long lastHeartbeatTime = 0;

float eco2Threshold = 1500.0;             // Ngưỡng cảnh báo eCO2 từ xa (ppm)
int   tvocThreshold = 600;                // Ngưỡng cảnh báo TVOC từ xa (ppb)
bool  fanState      = false;              // Trạng thái Quạt/Relay (false = OFF, true = ON)
bool  manualFanOn   = false;              // Lệnh bật quạt từ web được giữ tới khi có lệnh tắt
bool  alertActive   = false;              // Trạng thái vượt ít nhất một ngưỡng
bool  ccsAvailable  = false;

// Biến lưu giá trị đọc gần nhất
float currentTemp = 0.0;
float currentHum  = 0.0;
int   currentEco2 = 400;
int   currentTvoc = 0;

void updateFanState() {
  bool shouldFanRun = manualFanOn || alertActive;
  if (fanState != shouldFanRun) {
    fanState = shouldFanRun;
    digitalWrite(FAN_RELAY_PIN, fanState ? HIGH : LOW);
    Serial.printf("[FAN] Quat %s (web=%s, vuot_nguong=%s)\n",
                  fanState ? "BAT" : "TAT",
                  manualFanOn ? "ON" : "OFF",
                  alertActive ? "CO" : "KHONG");
  }
}

void loadSavedConfiguration() {
  configPreferencesReady = configPreferences.begin("air-config", false);
  if (!configPreferencesReady) {
    Serial.println("[ERROR] Khong the mo bo nho NVS, dung cau hinh mac dinh!");
    return;
  }

  sendIntervalMs = configPreferences.getULong("send-ms", sendIntervalMs);
  eco2Threshold = configPreferences.getFloat("eco2", eco2Threshold);
  tvocThreshold = configPreferences.getInt("tvoc", tvocThreshold);

  Serial.printf("[CONFIG] Da nap cau hinh -> Chu ky: %lu ms | Nguong eCO2: %.1f ppm | Nguong TVOC: %d ppb\n",
                sendIntervalMs, eco2Threshold, tvocThreshold);
}

// Lấy Unix Timestamp thực tế từ NTP Server
unsigned long getUnixTimestamp() {
  time_t now;
  struct tm timeinfo;
  if (!getLocalTime(&timeinfo, 100)) {
    return millis() / 1000;
  }
  time(&now);
  return now;
}

// =========================================================================
// 5. GỬI BẢN TIN TRẠNG THÁI (ONLINE / HEARTBEAT)
// =========================================================================
void publishStatus(const char* statusStr) {
  StaticJsonDocument<256> doc;
  doc["device_code"]      = DEVICE_CODE;
  doc["status"]           = statusStr;
  doc["firmware_version"] = FIRMWARE_VER;
  doc["ip_address"]       = WiFi.localIP().toString();
  doc["timestamp"]        = getUnixTimestamp();

  char buffer[256];
  serializeJson(doc, buffer);
  mqttClient.publish(TOPIC_STATUS, buffer, true);
  Serial.printf("[STATUS] Da gui trang thai: %s\n", buffer);
}

// =========================================================================
// 6. GỬI PHẢN HỒI XÁC NHẬN LỆNH ĐIỀU KHIỂN (ACK)
// =========================================================================
void publishAck(const char* cmdCode, const char* statusStr, const char* msg) {
  StaticJsonDocument<256> doc;
  doc["cmd_code"]          = cmdCode;
  doc["device_code"]       = DEVICE_CODE;
  doc["status"]            = statusStr;
  doc["current_fan_state"] = fanState ? "ON" : "OFF";
  doc["message"]           = msg;
  doc["timestamp"]         = getUnixTimestamp();

  char buffer[256];
  serializeJson(doc, buffer);
  mqttClient.publish(TOPIC_ACK, buffer, false);
  Serial.printf("[ACK] Da gui xac nhan lenh: %s\n", buffer);
}

// =========================================================================
// 7. XỬ LÝ BẢN TIN NHẬN TỪ CLOUD (LỆNH ĐIỀU KHIỂN & CẤU HÌNH TỪ XA)
// =========================================================================
void mqttCallback(char* topic, byte* payload, unsigned int length) {
  String message = "";
  for (unsigned int i = 0; i < length; i++) {
    message += (char)payload[i];
  }
  Serial.printf("\n[MQTT RECV] Topic: %s | Payload: %s\n", topic, message.c_str());

  StaticJsonDocument<512> doc;
  DeserializationError error = deserializeJson(doc, message);
  if (error) {
    Serial.println("[ERROR] JSON khong hop le!");
    return;
  }

  // TH1: Nhận lệnh điều khiển Bật/Tắt Quạt
  if (String(topic) == TOPIC_COMMAND) {
    const char* cmdCode = doc["cmd_code"] | "UNKNOWN_CMD";
    const char* target  = doc["target"]   | "FAN_RELAY";
    const char* action  = doc["action"]   | "";

    if (String(target) == "FAN_RELAY") {
      if (String(action) == "ON" || String(action) == "TURN_ON") {
        // Nếu quạt đã chạy chỉ do cảnh báo, lệnh ON không biến nó thành bật giữ.
        if (!fanState) {
          manualFanOn = true;
        }
        updateFanState();
        publishAck(cmdCode, "SUCCESS", "Da nhan lenh BAT quat");
      } 
      else if (String(action) == "OFF" || String(action) == "TURN_OFF") {
        manualFanOn = false;
        updateFanState();
        publishAck(cmdCode, "SUCCESS", alertActive
          ? "Da nhan lenh TAT; quat van bat do dang vuot nguong"
          : "Da TAT quat thong gio (GPIO 25 LOW)");
      } 
      else {
        publishAck(cmdCode, "FAILED", "Hanh dong (action) khong hop le");
      }
    }
  }
  // TH2: Nhận cấu hình tham số từ xa (Cập nhật chu kỳ, ngưỡng eCO2, ngưỡng TVOC)
  else if (String(topic) == TOPIC_CONFIG) {
    const char* cmdCode = doc["cmd_code"] | "CFG_CMD";
    bool saveSucceeded = true;

    if (doc.containsKey("send_interval_ms")) {
      unsigned long newInterval = doc["send_interval_ms"];
      if (newInterval >= 1000 && newInterval <= 60000) {
        sendIntervalMs = newInterval;
        if (!configPreferencesReady ||
            configPreferences.putULong("send-ms", sendIntervalMs) != sizeof(sendIntervalMs)) {
          saveSucceeded = false;
        }
      }
    }
    if (doc.containsKey("eco2_threshold")) {
      eco2Threshold = doc["eco2_threshold"];
      if (!configPreferencesReady ||
          configPreferences.putFloat("eco2", eco2Threshold) != sizeof(eco2Threshold)) {
        saveSucceeded = false;
      }
    }
    if (doc.containsKey("tvoc_threshold")) {
      tvocThreshold = doc["tvoc_threshold"];
      if (!configPreferencesReady ||
          configPreferences.putInt("tvoc", tvocThreshold) != sizeof(tvocThreshold)) {
        saveSucceeded = false;
      }
    }

    Serial.printf("[CONFIG] Cau hinh dang ap dung -> Chu ky: %lu ms | Nguong eCO2: %.1f ppm | Nguong TVOC: %d ppb\n",
                  sendIntervalMs, eco2Threshold, tvocThreshold);
    if (saveSucceeded) {
      publishAck(cmdCode, "SUCCESS", "Da cap nhat va luu cau hinh thiet bi");
    } else {
      Serial.println("[ERROR] Khong the luu cau hinh vao NVS!");
      publishAck(cmdCode, "FAILED", "Cau hinh da ap dung nhung khong luu duoc vao NVS");
    }
  }
}

// =========================================================================
// 8. KẾT NỐI WIFI & TỰ ĐỘNG KẾT NỐI LẠI MQTT (TLS 8883)
// =========================================================================
void setupWiFi() {
  Serial.printf("\n[WIFI] Dang ket noi toi %s", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.printf("\n[WIFI] Da ket noi! IP: %s\n", WiFi.localIP().toString().c_str());
}

void reconnectMQTT() {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[WIFI] Mat mang WiFi! Dang ket noi lai...");
    WiFi.disconnect();
    WiFi.reconnect();
    delay(2000);
    return;
  }

  static unsigned long lastReconnectAttempt = 0;
  unsigned long now = millis();
  if (now - lastReconnectAttempt < 5000) {
    return; // Đợi tối thiểu 5s giữa các lần kết nối lại
  }
  lastReconnectAttempt = now;

  if (!mqttClient.connected()) {
    Serial.printf("[MQTT] Dang ket noi EMQX Cloud (TLS)... Heap RAM: %d bytes\n", ESP.getFreeHeap());
    
    String clientId = "ESP32_NODE_01_PROD";
    const char* lwtPayload = "{\"device_code\":\"ESP32_NODE_01\",\"status\":\"OFFLINE\"}";

    if (mqttClient.connect(clientId.c_str(), MQTT_USERNAME, MQTT_PASSWORD, 
                           TOPIC_STATUS, 1, true, lwtPayload)) {
      Serial.println("[MQTT] KET NOI THANH CONG!");
      mqttClient.subscribe(TOPIC_COMMAND, 1);
      mqttClient.subscribe(TOPIC_CONFIG, 1);
      publishStatus("ONLINE");
    } else {
      int state = mqttClient.state();
      Serial.printf("[MQTT ERROR] That bai. Ma loi state = %d\n", state);
    }
  }
}

// =========================================================================
// 9. ĐỌC CẢM BIẾN, KIỂM TRA NGƯỠNG ĐỘNG VÀ GỬI TELEMETRY
// =========================================================================
void readAndPublishTelemetry() {
  // 1. Đọc Nhiệt độ & Độ ẩm từ DHT22
  float t = dht.readTemperature();
  float h = dht.readHumidity();

  if (!isnan(t) && !isnan(h)) {
    currentTemp = t;
    currentHum  = h;
  } else {
    Serial.println("[WARN] Khong doc duoc DHT22, giu nguyen gia tri cu!");
  }

  // 2. Đọc eCO2 & TVOC từ CCS811
  if (ccsAvailable && ccs.available()) {
    if (!isnan(t) && !isnan(h)) {
      ccs.setEnvironmentalData(currentHum, currentTemp);
    }
    if (!ccs.readData()) {
      currentEco2 = ccs.geteCO2();
      currentTvoc = ccs.getTVOC();
    } else {
      Serial.println("[WARN] Loi doc du lieu tu CCS811!");
    }
  }

  // 3. Logic cảnh báo theo đúng biến cấu hình động nhận từ Cloud
  bool isEco2Alert = (currentEco2 >= eco2Threshold);
  bool isTvocAlert = (currentTvoc >= tvocThreshold);
  alertActive = isEco2Alert || isTvocAlert;
  updateFanState();

  digitalWrite(ECO2_LED_PIN, isEco2Alert ? HIGH : LOW);
  digitalWrite(TVOC_LED_PIN, isTvocAlert ? HIGH : LOW);

  // Kích hoạt còi báo nếu vượt ngưỡng eCO2 hoặc TVOC
  if (isEco2Alert || isTvocAlert) {
    digitalWrite(BUZZER_PIN, HIGH);
    Serial.printf("[CANH BAO] Vuot nguong! eCO2: %d/%.0f | TVOC: %d/%d -> COI BAT\n",
                  currentEco2, eco2Threshold, currentTvoc, tvocThreshold);
  } else {
    digitalWrite(BUZZER_PIN, LOW);
  }

  // 4. Đóng gói JSON chuẩn và gửi qua MQTT
  StaticJsonDocument<512> doc;
  doc["device_code"]  = DEVICE_CODE;
  doc["secret_token"] = SECRET_TOKEN;
  doc["timestamp"]    = getUnixTimestamp();

  JsonObject metrics = doc.createNestedObject("metrics");
  metrics["temperature"]["value"] = serialized(String(currentTemp, 1));
  metrics["temperature"]["unit"]  = "C";
  metrics["humidity"]["value"]    = serialized(String(currentHum, 1));
  metrics["humidity"]["unit"]     = "%";
  metrics["eco2"]["value"]        = currentEco2;
  metrics["eco2"]["unit"]         = "ppm";
  metrics["tvoc"]["value"]        = currentTvoc;
  metrics["tvoc"]["unit"]         = "ppb";

  JsonObject actuator = doc.createNestedObject("actuator_state");
  actuator["fan_relay"] = fanState ? "ON" : "OFF";

  char buffer[512];
  serializeJson(doc, buffer);

  if (mqttClient.publish(TOPIC_TELEMETRY, buffer, false)) {
    Serial.printf("[TELEMETRY] %s\n", buffer);
  } else {
    Serial.println("[ERROR] Gui Telemetry that bai!");
  }
}

// =========================================================================
// 10. SETUP VÀ LOOP
// =========================================================================
void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("\n=== KHOI DONG TRAM GIAM SAT KHONG KHI IoT (NHOM 13) ===");

  pinMode(FAN_RELAY_PIN, OUTPUT);
  digitalWrite(FAN_RELAY_PIN, LOW);

  pinMode(ECO2_LED_PIN, OUTPUT);
  digitalWrite(ECO2_LED_PIN, LOW);

  pinMode(TVOC_LED_PIN, OUTPUT);
  digitalWrite(TVOC_LED_PIN, LOW);

  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(BUZZER_PIN, LOW);

  loadSavedConfiguration();

  // Khởi động cảm biến
  dht.begin();
  Wire.begin(I2C_SDA, I2C_SCL);
  if (ccs.begin(0x5A) || ccs.begin(0x5B)) {
    ccsAvailable = true;
    Serial.println("[SENSOR] Khoi tao CCS811 thanh cong!");
  } else {
    Serial.println("[WARN] Khong tim thay CCS811! Kiem tra chan WAKE da noi GND chua.");
  }

  // Kết nối WiFi & NTP
  setupWiFi();
  configTime(7 * 3600, 0, "pool.ntp.org", "time.nist.gov");

  // Thiết lập MQTT TLS
  espClient.setInsecure();
  espClient.setHandshakeTimeout(30);
  mqttClient.setServer(MQTT_BROKER, MQTT_PORT);
  mqttClient.setKeepAlive(60);
  mqttClient.setSocketTimeout(15);
  mqttClient.setCallback(mqttCallback);
  mqttClient.setBufferSize(1024);
}

void loop() {
  if (!mqttClient.connected()) {
    reconnectMQTT();
  }
  mqttClient.loop();

  unsigned long now = millis();

  // Chu kỳ gửi Telemetry
  if (now - lastTelemetryTime >= sendIntervalMs) {
    lastTelemetryTime = now;
    readAndPublishTelemetry();
  }

  // Chu kỳ gửi Heartbeat
  if (now - lastHeartbeatTime >= heartbeatInterval) {
    lastHeartbeatTime = now;
    publishStatus("ONLINE");
  }
}