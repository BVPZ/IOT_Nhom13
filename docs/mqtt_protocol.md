# Thiết kế Giao thức MQTT & Luồng Dữ liệu (Mục 4.3 & Mục 6)

## 1. Danh sách MQTT Topics
Hệ thống sử dụng cấu trúc phân cấp Topic theo mã định danh thiết bị (`{device_code}`, ví dụ: `ESP32_NODE_01`):

| STT | Topic | Chiều dữ liệu | QoS | Retain | Mục đích |
| :--- | :--- | :--- | :---: | :---: | :--- |
| 1 | `iot_nhom13/{device_code}/telemetry` | ESP32 $\rightarrow$ Backend | 1 | False | Gửi dữ liệu cảm biến DHT22 & CCS811 định kỳ |
| 2 | `iot_nhom13/{device_code}/status` | ESP32 $\rightarrow$ Backend | 1 | True | Báo trạng thái `ONLINE` / `OFFLINE` (tích hợp LWT) |
| 3 | `iot_nhom13/{device_code}/command` | Backend $\rightarrow$ ESP32 | 1 | False | Gửi lệnh điều khiển quạt/còi/LED từ giao diện Web |
| 4 | `iot_nhom13/{device_code}/ack` | ESP32 $\rightarrow$ Backend | 1 | False | Thiết bị xác nhận đã thực thi lệnh điều khiển |
| 5 | `iot_nhom13/{device_code}/config` | Backend $\rightarrow$ ESP32 | 1 | False | Cấu hình từ xa chu kỳ gửi và ngưỡng cảnh báo |

---

## 2. Cấu trúc Bản tin JSON (Payload Format)

### 2.1. Bản tin Telemetry (`iot_nhom13/ESP32_NODE_01/telemetry`)
```json
{
  "device_code": "ESP32_NODE_01",
  "secret_token": "sec_tok_esp32_node01_998877aabbcc",
  "timestamp": 1762320000,
  "metrics": {
    "temperature": { "value": 28.5, "unit": "C" },
    "humidity": { "value": 64.0, "unit": "%" },
    "eco2": { "value": 820, "unit": "ppm" },
    "tvoc": { "value": 65, "unit": "ppb" }
  },
  "actuator_state": {
    "fan_relay": "OFF"
  }
}