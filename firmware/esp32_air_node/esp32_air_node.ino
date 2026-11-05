#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include <DHT.h>
#include "Adafruit_CCS811.h"
#include <time.h>
#include "secrets.h"

// =========================================================================
// 1. CẤU HÌNH WIFI & HIVEMQ CLOUD (THAY BẰNG THÔNG TIN CỦA BẠN)
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
// 3. CẤU HÌNH CHÂN CẮM PHẦN CỨNG (Theo đúng sơ đồ mạch hiện tại)
// =========================================================================
#define DHTPIN        4       // Chân OUT của DHT22 cắm vào D4 (GPIO 4)
#define DHTTYPE       DHT22
#define I2C_SDA       21      // Chân SDA của CCS811 cắm vào D21
#define I2C_SCL       22      // Chân SCL của CCS811 cắm vào D22
#define FAN_RELAY_PIN 2       // Đèn LED tích hợp trên mạch (D2) giả lập Quạt/Relay
#define ECO2_LED_PIN  16      // LED xanh: eCO2 vượt 1000 ppm
#define TVOC_LED_PIN  17      // LED đỏ: TVOC vượt 100 ppb
#define BUZZER_PIN    19      // Còi báo khi eCO2 hoặc TVOC vượt ngưỡng

DHT dht(DHTPIN, DHTTYPE);
Adafruit_CCS811 ccs;
WiFiClientSecure espClient;
PubSubClient mqttClient(espClient);

// =========================================================================
// 4. BIẾN TRẠNG THÁI & THAM SỐ CẤU HÌNH TỪ XA (REMOTE CONFIG)
// =========================================================================
unsigned long sendIntervalMs    = 1000;   // Mặc định 1 giây gửi telemetry 1 lần
unsigned long heartbeatInterval = 30000;  // Mặc định 30 giây gửi heartbeat 1 lần
unsigned long lastTelemetryTime = 0;
unsigned long lastHeartbeatTime = 0;

float eco2Threshold = 1000.0;             // Ngưỡng cảnh báo tại chỗ (ppm)
bool  fanState      = false;              // Trạng thái Quạt/Relay (false = OFF, true = ON)
bool  ccsAvailable  = false;

// Biến lưu giá trị đọc gần nhất
float currentTemp = 0.0;
float currentHum  = 0.0;
int   currentEco2 = 400;
int   currentTvoc = 0;

// Lấy Unix Timestamp thực tế từ NTP Server (Mục 4.3)
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
  // Retain = true để Backend luôn biết trạng thái mới nhất của thiết bị
  mqttClient.publish(TOPIC_STATUS, buffer, true);
  Serial.printf("[STATUS] Da gui trang thai: %s\n", buffer);
}

// =========================================================================
// 6. GỬI PHẢN HỒI XÁC NHẬN LỆNH ĐIỀU KHIỂN (ACK - Mục 4.3 & 4.4e)
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
// 7. XỬ LÝ BẢN TIN NHẬN TỪ BACKEND (LỆNH ĐIỀU KHIỂN & CẤU HÌNH TỪ XA)
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

  // TH1: Nhận lệnh điều khiển Bật/Tắt Quạt (Mục 4.4e & Demo bước 5)
  if (String(topic) == TOPIC_COMMAND) {
    const char* cmdCode = doc["cmd_code"] | "UNKNOWN_CMD";
    const char* target  = doc["target"]   | "FAN_RELAY";
    const char* action  = doc["action"]   | "";

    if (String(target) == "FAN_RELAY") {
      if (String(action) == "ON" || String(action) == "TURN_ON") {
        fanState = true;
        digitalWrite(FAN_RELAY_PIN, HIGH);
        publishAck(cmdCode, "SUCCESS", "Da BAT quat thong gio (GPIO 2 HIGH)");
      } 
      else if (String(action) == "OFF" || String(action) == "TURN_OFF") {
        fanState = false;
        digitalWrite(FAN_RELAY_PIN, LOW);
        publishAck(cmdCode, "SUCCESS", "Da TAT quat thong gio (GPIO 2 LOW)");
      } 
      else {
        publishAck(cmdCode, "FAILED", "Hanh dong (action) khong hop le");
      }
    }
  }
  // TH2: Nhận cấu hình tham số từ xa (Mục 4.2, 4.4b & Demo bước 6)
  else if (String(topic) == TOPIC_CONFIG) {
    const char* cmdCode = doc["cmd_code"] | "CFG_CMD";
    if (doc.containsKey("send_interval_ms")) {
      unsigned long newInterval = doc["send_interval_ms"];
      if (newInterval >= 1000 && newInterval <= 60000) {
        sendIntervalMs = newInterval;
      }
    }
    if (doc.containsKey("eco2_threshold")) {
      eco2Threshold = doc["eco2_threshold"];
    }
    Serial.printf("[CONFIG] Cap nhat chu ky gui: %lu ms, Nguong eCO2: %.1f ppm\n", sendIntervalMs, eco2Threshold);
    publishAck(cmdCode, "SUCCESS", "Da cap nhat cau hinh thiet bi tu xa");
  }
}

// =========================================================================
// 8. KẾT NỐI WIFI & TỰ ĐỘNG KẾT NỐI LẠI MQTT (CÓ LWT - Mục 4.2 & 4.3)
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

// =========================================================================
// HÀM KẾT NỐI LẠI MQTT ĐƯỢC TỐI ƯU HÓA CHỐNG RỚT KẾT NỐI
// =========================================================================
void reconnectMQTT() {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[WIFI] Mat mang WiFi! Dang ket noi lai...");
    WiFi.disconnect();
    WiFi.reconnect();
    delay(2000);
    return;
  }

  // Nếu chưa tới thời điểm thử lại (tránh spam Broker liên tục làm nghẽn TLS)
  static unsigned long lastReconnectAttempt = 0;
  unsigned long now = millis();
  if (now - lastReconnectAttempt < 5000) {
    return; // Đợi tối thiểu 5s giữa các lần thử
  }
  lastReconnectAttempt = now;

  if (!mqttClient.connected()) {
    Serial.printf("[MQTT] Dang ket noi EMQX Cloud (TLS)... Heap RAM: %d bytes\n", ESP.getFreeHeap());
    
    // 1. Cố định Client ID duy nhất, không dùng random tránh bị Broker từ chối
    String clientId = "ESP32_NODE_01_PROD";

    // 2. Chuẩn bị bản tin Last Will (LWT)
    const char* lwtPayload = "{\"device_code\":\"ESP32_NODE_01\",\"status\":\"OFFLINE\"}";

    // 3. Thực hiện kết nối
    if (mqttClient.connect(clientId.c_str(), MQTT_USERNAME, MQTT_PASSWORD, 
                           TOPIC_STATUS, 1, true, lwtPayload)) {
      Serial.println("[MQTT] KET NOI THANH CONG!");
      mqttClient.subscribe(TOPIC_COMMAND, 1);
      mqttClient.subscribe(TOPIC_CONFIG, 1);
      publishStatus("ONLINE");
    } else {
      // In rõ mã lỗi MQTT để chẩn đoán chính xác nguyên nhân
      int state = mqttClient.state();
      Serial.printf("[MQTT ERROR] That bai. Ma loi state = %d. ", state);
      if (state == -2) Serial.println("(Loi ket noi TCP/Mang internet)");
      else if (state == -4) Serial.println("(Timeout khi bat tay SSL/TLS)");
      else if (state == 4) Serial.println("(Sai Username/Password tren EMQX)");
      else if (state == 5) Serial.println("(Broker tu choi Client ID/Khong du quyen ACL)");
      else Serial.println("(Kiem tra lai Broker URL va Port 8883)");
    }
  }
}

// =========================================================================
// 9. ĐỌC CẢM BIẾN DHT22 + CCS811 & GỬI TELEMETRY
// =========================================================================
void readAndPublishTelemetry() {
  // 1. Đọc Nhiệt độ & Độ ẩm từ DHT22 (chân D4)
  float t = dht.readTemperature();
  float h = dht.readHumidity();

  if (!isnan(t) && !isnan(h)) {
    currentTemp = t;
    currentHum  = h;
  } else {
    Serial.println("[WARN] Khong doc duoc DHT22, giu gia tri cu hoac kiem tra day D4!");
  }

  // 2. Đọc eCO2 & TVOC từ CCS811 (chân D21, D22)
  if (ccsAvailable && ccs.available()) {
    // Bù nhiệt độ và độ ẩm từ DHT22 vào CCS811 để tăng độ chính xác
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

  digitalWrite(ECO2_LED_PIN, currentEco2 > 1000 ? HIGH : LOW);
  digitalWrite(TVOC_LED_PIN, currentTvoc > 100 ? HIGH : LOW);
  digitalWrite(BUZZER_PIN, (currentEco2 > 1500 || currentTvoc > 600) ? HIGH : LOW);

  // 3. Đóng gói JSON theo đúng chuẩn docs/mqtt_protocol.md
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
// 10. HÀM SETUP & LOOP CHÍNH
// =========================================================================
void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("\n=== KHOI DONG TRAM GIAM SAT KHONG KHI IoT (NHOM 13) ===");
  // Cấu hình chân cơ cấu chấp hành (LED D2 / Relay)
  pinMode(FAN_RELAY_PIN, OUTPUT);
  digitalWrite(FAN_RELAY_PIN, LOW);
  pinMode(ECO2_LED_PIN, OUTPUT);
  digitalWrite(ECO2_LED_PIN, LOW);
  pinMode(TVOC_LED_PIN, OUTPUT);
  digitalWrite(TVOC_LED_PIN, LOW);
  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(BUZZER_PIN, LOW);

  // Khởi tạo DHT22 trên chân D4
  dht.begin();

  // Khởi tạo I2C (SDA=21, SCL=22) và cảm biến CCS811
  Wire.begin(I2C_SDA, I2C_SCL);
  // Lưu ý: Địa chỉ I2C mặc định của CCS811 là 0x5A (một số module dùng 0x5B)
  if (ccs.begin(0x5A) || ccs.begin(0x5B)) {
    ccsAvailable = true;
    Serial.println("[SENSOR] Khoi tao CCS811 thanh cong!");
  } else {
    Serial.println("[WARN] Khong tim thay CCS811! Kiem tra chan WAKE da noi GND chua.");
  }

  // Kết nối WiFi & Đồng bộ giờ quốc tế (NTP)
  setupWiFi();
  configTime(7 * 3600, 0, "pool.ntp.org", "time.nist.gov");

  // Bỏ qua kiểm tra chứng chỉ gốc CA trên ESP32 nhưng vẫn mã hóa luồng TLS 8883
  espClient.setInsecure();
  espClient.setHandshakeTimeout(30);
  mqttClient.setServer(MQTT_BROKER, MQTT_PORT);
  mqttClient.setKeepAlive(60);
  mqttClient.setSocketTimeout(15);
  mqttClient.setCallback(mqttCallback);
  mqttClient.setBufferSize(1024);
}

void loop() {
  // Đảm bảo luôn duy trì kết nối mạng và MQTT (Mục 4.2)
  if (!mqttClient.connected()) {
    reconnectMQTT();
  }
  mqttClient.loop();

  unsigned long now = millis();

  // Định kỳ gửi dữ liệu cảm biến (Telemetry)
  if (now - lastTelemetryTime >= sendIntervalMs) {
    lastTelemetryTime = now;
    readAndPublishTelemetry();
  }

  // Định kỳ gửi Heartbeat (Mục 4.2)
  if (now - lastHeartbeatTime >= heartbeatInterval) {
    lastHeartbeatTime = now;
    publishStatus("ONLINE");
  }
}