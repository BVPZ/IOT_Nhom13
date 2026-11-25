# Hệ thống IoT giám sát chất lượng không khí

Dự án sử dụng các node ESP32 để đo nhiệt độ, độ ẩm, eCO₂ và TVOC; gửi dữ liệu qua MQTT về backend; lưu dữ liệu trên MySQL; và cung cấp dashboard web để giám sát, xem cảnh báo và điều khiển quạt.

## Tổng quan

```text
ESP32 + cảm biến ── MQTT/TLS ──► MQTT broker ──► FastAPI ──► MySQL
                                      ▲             ▲
                                      │             │ REST API
                                      └─────────────┤
                                                    ▼
                                               React dashboard
                                                    │
                                         Telegram (cảnh báo)
```

ESP32 và backend trao đổi qua MQTT. Trình duyệt gọi REST API của backend; dashboard làm mới dữ liệu định kỳ, không kết nối MQTT/WebSocket trực tiếp. Firmware có thể điều khiển quạt tự động theo ngưỡng eCO₂/TVOC đã cấu hình. Thư mục `ML/` chứa chương trình huấn luyện mô hình dự báo eCO₂ riêng; hiện đây là bước chạy độc lập, chưa được backend dùng làm bộ điều khiển tự động.

## Chức năng chính

- Theo dõi nhiệt độ, độ ẩm, eCO₂, TVOC, trạng thái node và quạt.
- Lưu lịch sử đo, cảnh báo, lệnh điều khiển và nhật ký hoạt động trong MySQL.
- Cảnh báo trên dashboard và gửi thông báo Telegram khi được cấu hình.
- Điều khiển quạt và cập nhật chu kỳ gửi/ngưỡng từ dashboard.
- Phân quyền theo node: tài khoản có vai trò `ADMIN`, `OPERATOR` hoặc `VIEWER`; quyền trên từng node là `VIEW` hoặc `CONTROL`.
- Node có chế độ `PUBLIC` hoặc `PRIVATE`. Node `PUBLIC` cho người dùng đã đăng nhập xem dữ liệu; quyền điều khiển vẫn cần được cấp. Node `PRIVATE` chỉ hiển thị với người được cấp quyền và admin.

## Cấu trúc dự án

```text
backend/                       FastAPI, MQTT worker, Telegram notifier
database/schema.sql            Schema MySQL cho CSDL mới
database/migrations/           Migration cho CSDL đang sử dụng
docs/mqtt_protocol.md          Mô tả topic và payload MQTT
firmware/esp32_air_node1/      Firmware cho ESP32, DHT22, CCS811
firmware/esp32_air_node2/      Firmware cho ESP32-S3, DHT11, CCS811
hardware/                      Sơ đồ lắp mạch
frontend/                      React + Vite dashboard

```

## Cài đặt và chạy

### 1. Cấu hình môi trường

Tạo `.env` ở thư mục gốc dự án (hoặc trong `backend/`) dựa trên `.env.example`:

```env
MQTT_BROKER_URL=your-broker-host
MQTT_BROKER_PORT=8883
MQTT_USERNAME=your-mqtt-username
MQTT_PASSWORD=your-mqtt-password

DB_HOST=your-mysql-host
DB_PORT=3306
DB_USER=your-mysql-username
DB_PASSWORD=your-mysql-password
DB_NAME=your-database-name

JWT_SECRET_KEY=replace-with-a-long-random-secret
JWT_ALGORITHM=HS256

TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
```

Backend đọc MQTT từ `MQTT_BROKER_URL`, `MQTT_BROKER_PORT`, `MQTT_USERNAME`, `MQTT_PASSWORD`; MySQL từ nhóm `DB_*`; và khóa ký token từ `JWT_SECRET_KEY`. Hãy dùng cùng một `JWT_SECRET_KEY` ổn định cho các lần chạy backend. Telegram là tùy chọn.

### 2. Cơ sở dữ liệu

- CSDL mới: chạy `database/schema.sql` trên MySQL.
- CSDL đã có dữ liệu: áp dụng các migration cần thiết trong `database/migrations/`. Migration `20261125_add_device_visibility.sql` thêm chế độ hiển thị node; node cũ được đặt mặc định là `PRIVATE`.
- Đảm bảo tài khoản MySQL có quyền tạo/cập nhật bảng và backend kết nối được tới máy chủ.

### 3. Backend

Từ thư mục gốc dự án:

```bash
python -m venv .venv
# Windows PowerShell
.venv\Scripts\Activate.ps1
# macOS/Linux: source .venv/bin/activate
pip install -r backend/requirements.txt
uvicorn backend.main:app --host 0.0.0.0 --port 8000 --reload
```

Backend cần MySQL để phục vụ API và MQTT broker để nhận dữ liệu thiết bị. Khi chạy nhiều worker/tiến trình, tất cả cần dùng cùng `JWT_SECRET_KEY`.

### 4. Frontend

```bash
cd frontend
npm install
npm run dev
```

Khi phát triển cục bộ, frontend mặc định gọi API tại `http://127.0.0.1:8000`. Có thể đặt `VITE_API_BASE_URL` nếu backend ở địa chỉ khác; giá trị này là địa chỉ gốc, không thêm `/api` ở cuối.

### 5. Firmware ESP32

Mở một trong các sketch tương ứng bằng Arduino IDE:

- `firmware/esp32_air_node1/esp32_air_node1.ino`: ESP32-WROOM, DHT22, CCS811, relay, hai LED và còi.
- `firmware/esp32_air_node2/esp32_air_node2.ino`: ESP32-S3, DHT11, CCS811, relay và còi.

Cài các thư viện Arduino tương ứng với include trong sketch: `PubSubClient`, `ArduinoJson`, `DHT sensor library` và `Adafruit CCS811`. Mỗi thư mục firmware cần file `secrets.h` cục bộ để khai báo Wi-Fi, broker MQTT và token thiết bị; file này được gitignore. Không đưa mật khẩu hoặc token thật vào README hay mã nguồn công khai. Mã `NODE_DEVICE_CODE` trong firmware phải trùng mã node đã đăng ký trong ứng dụng.

Các topic dùng tiền tố `iot_nhom13/<device_code>/`; danh sách topic và cấu trúc payload nằm trong [docs/mqtt_protocol.md](docs/mqtt_protocol.md). Chi tiết nối dây xem [hardware/so_do_lap_mach.md](hardware/so_do_lap_mach.md); lưu ý hai firmware dùng loại board và chân khác nhau.

## Phân quyền và thêm node

Tài khoản tự đăng ký có vai trò `VIEWER`. `ADMIN` quản trị node và phân quyền; `OPERATOR` và `VIEWER` được kiểm tra quyền theo từng node. `VIEW` cho phép xem; `CONTROL` cho phép thao tác điều khiển/cấu hình và xác nhận cảnh báo theo chức năng được cấp.

Admin thêm node trong mục **Quản lý phân quyền → Thêm node**, chọn chế độ hiển thị và sao chép token thiết bị. Điền mã node và token đó vào cấu hình `secrets.h` cục bộ của firmware rồi nạp lại ESP32. Không dùng chung một mã node cho nhiều thiết bị hoạt động đồng thời.

## Huấn luyện mô hình ML (tùy chọn)

`ML/train_predictor.py` huấn luyện mô hình dự báo eCO₂ trong tương lai từ dữ liệu lịch sử của một node và ghi tệp `.joblib` trong `ML/`. Cài thư viện từ `ML/requirements.txt`, cấu hình kết nối MySQL và chạy từ thư mục gốc:

```bash
pip install -r ML/requirements.txt
python ML/train_predictor.py
```

Có thể chọn node bằng `PREDICTOR_DEVICE_CODE`; các tham số huấn luyện khác được đọc từ biến môi trường, xem đầu tệp script. Mô hình này hiện phục vụ huấn luyện/lưu artifact; dashboard/backend chưa nạp nó để dự báo hoặc tự điều khiển quạt.

## Tài liệu liên quan

- [Giao thức MQTT](docs/mqtt_protocol.md)
- [Sơ đồ lắp mạch](hardware/so_do_lap_mach.md)
- [Schema cơ sở dữ liệu](database/schema.sql)
