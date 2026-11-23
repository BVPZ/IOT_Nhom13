# IOT_Nhom13

## Phân quyền theo node

Hệ thống giữ ba vai trò tài khoản `ADMIN`, `OPERATOR` và `VIEWER`. Admin có quyền quản trị tất cả node. Với hai vai trò còn lại, quyền được kiểm tra riêng cho từng node đã được duyệt:

- `VIEW` cho phép xem số liệu và cảnh báo.
- `CONTROL` có thêm quyền bật/tắt quạt, cập nhật cấu hình và xác nhận cảnh báo.

Tài khoản tự đăng ký có vai trò `VIEWER`. Sau khi đăng nhập, người dùng mở **Danh mục node**, chọn **Xin quyền truy cập** và gửi yêu cầu cho admin. Trong **Quản lý phân quyền**, admin có thể duyệt hoặc từ chối yêu cầu, cấp quyền trực tiếp cho tài khoản hiện có, đổi mức quyền, thu hồi quyền hoặc tạo tài khoản kèm quyền trên nhiều node.

### Cập nhật cơ sở dữ liệu và triển khai

1. Chạy [database/schema.sql](database/schema.sql) trên MySQL đang dùng trước khi triển khai backend. Schema thêm bảng `device_permissions` bằng `CREATE TABLE IF NOT EXISTS`. Dữ liệu và vai trò tài khoản hiện có được giữ lại.
2. Triển khai backend và frontend đã cập nhật. Đặt `JWT_SECRET_KEY` trong môi trường backend để các tiến trình dùng cùng khóa ký. Frontend gọi FastAPI khoảng mỗi 5 giây khi có dashboard đang mở. ESP32 và backend tiếp tục giao tiếp qua MQTT.
3. Cấp lại quyền theo node cho các tài khoản `OPERATOR` và `VIEWER` hiện có trong **Quản lý phân quyền**.
4. Đổi thông tin đăng nhập MQTT từng xuất hiện trong mã hoặc build frontend cũ, rồi cập nhật thông tin mới trên backend và firmware. Việc này đóng đường truy cập trực tiếp vào broker bằng thông tin cũ.

### Thêm node ESP32

Trong **Quản lý phân quyền → Thêm node**, nhập mã node, tên và vị trí. Sao chép token được hiển thị sau khi tạo. Trong `firmware/esp32_air_node/secrets.h` của thiết bị mới, khai báo `#define NODE_DEVICE_CODE "MA_NODE"` và đặt `SECRET_TOKEN` bằng token tương ứng, sau đó nạp firmware. Mã node được dùng cho các topic MQTT và định danh của ESP32.
