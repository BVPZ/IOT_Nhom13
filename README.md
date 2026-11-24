# IOT_Nhom13

## Phân quyền theo node

Hệ thống giữ ba vai trò tài khoản `ADMIN`, `OPERATOR` và `VIEWER`. Admin có quyền quản trị tất cả node. Với hai vai trò còn lại, quyền được kiểm tra riêng cho từng node đã được duyệt:

- `VIEW` cho phép xem số liệu và cảnh báo.
- `CONTROL` có thêm quyền bật/tắt quạt, cập nhật cấu hình và xác nhận cảnh báo.

Tài khoản tự đăng ký có vai trò `VIEWER`. Sau khi đăng nhập, người dùng mở **Danh mục node**, chọn **Xin quyền truy cập** và gửi yêu cầu cho admin. Trong **Quản lý phân quyền**, admin có thể duyệt hoặc từ chối yêu cầu, cấp quyền trực tiếp cho tài khoản hiện có, đổi mức quyền, thu hồi quyền hoặc tạo tài khoản kèm quyền trên nhiều node.

### Cập nhật cơ sở dữ liệu và triển khai

1. CSDL hiện có cần chạy migration [20261125_add_device_visibility.sql](database/migrations/20261125_add_device_visibility.sql); node cũ được đặt `PRIVATE` để không mở dữ liệu ngoài ý muốn. Với CSDL mới, trường `visibility` đã có trong [database/schema.sql](database/schema.sql). Migration đã được áp dụng vào CSDL cấu hình hiện tại.
2. Triển khai backend và frontend đã cập nhật. Đặt `JWT_SECRET_KEY` trong môi trường backend để các tiến trình dùng cùng khóa ký. Frontend gọi FastAPI khoảng mỗi 5 giây khi có dashboard đang mở. ESP32 và backend tiếp tục giao tiếp qua MQTT.
3. Cấp lại quyền theo node cho các tài khoản `OPERATOR` và `VIEWER` hiện có trong **Quản lý phân quyền**.
4. Đổi thông tin đăng nhập MQTT từng xuất hiện trong mã hoặc build frontend cũ, rồi cập nhật thông tin mới trên backend và firmware. Việc này đóng đường truy cập trực tiếp vào broker bằng thông tin cũ.

### Thêm node ESP32

Trong **Quản lý phân quyền → Thêm node**, nhập mã node, tên và vị trí. Sao chép token được hiển thị sau khi tạo. Trong `firmware/esp32_air_node/secrets.h` của thiết bị mới, khai báo `#define NODE_DEVICE_CODE "MA_NODE"` và đặt `SECRET_TOKEN` bằng token tương ứng, sau đó nạp firmware. Mã node được dùng cho các topic MQTT và định danh của ESP32.

Khi tạo node, chọn `PUBLIC` để mọi tài khoản đã đăng nhập được xem dữ liệu và có thể gửi yêu cầu xin quyền điều khiển; hoặc chọn `PRIVATE` rồi chọn quyền cho từng tài khoản. Người chưa được cấp quyền không nhìn thấy node riêng tư và không thể tự gửi yêu cầu truy cập. Node công khai chỉ cho xem; các thao tác điều khiển vẫn cần quyền `CONTROL` được admin duyệt.
