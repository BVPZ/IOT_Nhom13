# YÊU CẦU TRIỂN KHAI TÍNH NĂNG PHÂN QUYỀN TRUY CẬP THIẾT BỊ THEO NODE (RBAC + PER-DEVICE PERMISSION)

## 1. Bối cảnh & Mục tiêu hệ thống
Hệ thống IoT giám sát chất lượng không khí (ESP32, FastAPI Backend, React Frontend, MySQL) cần bổ sung cơ chế phân quyền chi tiết đến từng node thiết bị (`devices`).
Hỗ trợ 2 luồng cấp quyền:
- **Luồng A (Admin chủ động):** Admin tạo tài khoản mới và gán trực tiếp quyền truy cập các node thiết bị cho user.
- **Luồng B (User tự đăng ký & xin quyền):** User tự đăng ký tài khoản, xem danh mục thiết bị công khai (chỉ thông tin nhận diện cơ bản), gửi yêu cầu xin quyền truy cập node mong muốn, và chờ Admin phê duyệt.

---

## 2. Cấu trúc Database (MySQL)
Sử dụng bảng `device_permissions` liên kết giữa `users` và `devices`:

```sql
CREATE TABLE IF NOT EXISTS device_permissions (
    id INT NOT NULL AUTO_INCREMENT,
    user_id INT NOT NULL,
    device_id INT NOT NULL,
    permission ENUM('VIEW', 'CONTROL') NOT NULL DEFAULT 'VIEW',
    status ENUM('PENDING', 'APPROVED', 'REJECTED') NOT NULL DEFAULT 'APPROVED',
    request_note VARCHAR(255) DEFAULT NULL,
    granted_by INT DEFAULT NULL,
    requested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    granted_at TIMESTAMP NULL DEFAULT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_user_device (user_id, device_id),
    KEY idx_device_id (device_id),
    KEY idx_granted_by (granted_by),
    KEY idx_status (status),
    CONSTRAINT fk_dp_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_dp_device FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
    CONSTRAINT fk_dp_granted_by FOREIGN KEY (granted_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
```

---

## 3. Đặc tả Luồng Nghiệp Vụ & API Backend (FastAPI)

### Quy tắc chung:
- Tài khoản có `role == 'ADMIN'` có toàn quyền truy cập, điều khiển và cấu hình tất cả các thiết bị mà không cần bản ghi trong `device_permissions`.
- Tài khoản có `role != 'ADMIN'` chỉ được phép thao tác trên các thiết bị có bản ghi `status == 'APPROVED'` trong `device_permissions`.

### Danh sách API cần triển khai / cập nhật:

1. **Danh mục thiết bị & Trạng thái quyền của User hiện tại:**
   - **Endpoint:** `GET /api/devices/catalog`
   - **Logic:**
     - Nếu là `ADMIN`: Trả về toàn bộ thiết bị (trừ `DECOMMISSIONED`) với `access_status = 'APPROVED'` và `permission = 'CONTROL'`.
     - Nếu là `USER`: Thực hiện `LEFT JOIN` bảng `devices` với `device_permissions` theo `user_id` hiện tại. Chỉ trả về thông tin nhận diện cơ bản (`id`, `device_code`, `device_name`, `location`, `lifecycle_status`, `access_status`, `permission`). **Tuyệt đối không trả về `secret_token` hay dữ liệu telemetry ở API này.**

2. **User gửi yêu cầu xin quyền truy cập Node:**
   - **Endpoint:** `POST /api/permissions/request`
   - **Payload:** `{ "device_id": int, "requested_permission": "VIEW" | "CONTROL", "request_note": str }`
   - **Logic:**
     - Kiểm tra thiết bị tồn tại và không ở trạng thái `DECOMMISSIONED`.
     - Kiểm tra trong `device_permissions`:
       - Nếu đã tồn tại bản ghi `APPROVED` hoặc `PENDING` -> trả về lỗi `400` ("Bạn đã có quyền hoặc đang có yêu cầu chờ duyệt cho thiết bị này").
       - Nếu trước đó bị `REJECTED` -> cập nhật lại thành `status = 'PENDING'`, cập nhật `permission`, `request_note`, `requested_at = NOW()`.
       - Nếu chưa có -> `INSERT` bản ghi mới với `status = 'PENDING'`, `granted_by = NULL`.

3. **Admin tạo tài khoản kèm phân quyền trực tiếp (Luồng A):**
   - **Endpoint:** `POST /api/admin/users`
   - **Payload:** `{ "username": str, "password": str, "full_name": str, "role": "USER" | "ADMIN", "device_grants": [ { "device_id": int, "permission": "VIEW" | "CONTROL" } ] }`
   - **Logic:**
     - Tạo user trong bảng `users` (hash mật khẩu).
     - Nếu `device_grants` không rỗng, lặp qua danh sách và `INSERT` vào `device_permissions` với `status = 'APPROVED'`, `granted_by = current_admin.id`, `granted_at = NOW()`.

4. **Admin quản lý & Phê duyệt yêu cầu (Luồng B):**
   - **Lấy danh sách yêu cầu chờ duyệt:** `GET /api/admin/permissions/pending` (Join với `users` và `devices` để lấy `username`, `full_name`, `device_code`, `device_name`, `permission`, `request_note`, `requested_at`).
   - **Duyệt hoặc Từ chối yêu cầu:** `PUT /api/admin/permissions/{permission_id}/review`
     - **Payload:** `{ "action": "APPROVE" | "REJECT", "permission": "VIEW" | "CONTROL" }` *(Cho phép Admin hạ hoặc nâng mức quyền trước khi duyệt)*.
     - **Logic:** Cập nhật `status` thành `'APPROVED'` hoặc `'REJECTED'`, gán `granted_by = current_admin.id`, `granted_at = NOW()`.
   - **Thu hồi / Chỉnh sửa quyền bất kỳ lúc nào:** `PUT /api/admin/permissions/{permission_id}` hoặc `DELETE /api/admin/permissions/{permission_id}`.

5. **Middleware / Dependency kiểm tra quyền trên các API vận hành hiện có:**
   - Tạo hàm dependency `verify_device_access(device_code, required_permission="VIEW")`:
     - Với `GET /api/telemetry/...`, `GET /api/alerts/...`: Yêu cầu tối thiểu `VIEW` (`APPROVED`). Nếu không hợp lệ trả về `403 Forbidden`.
     - Với `POST /api/command/...`, `PUT /api/config/...`: Yêu cầu bắt buộc `CONTROL` (`APPROVED`). Nếu chỉ có quyền `VIEW`, trả về `403 Forbidden` ("Bạn chỉ có quyền xem, không có quyền điều khiển thiết bị này").

---

## 4. Đặc tả Giao diện Frontend (React)

1. **Màn hình Danh mục & Chọn thiết bị (Dành cho User):**
   - Gọi `GET /api/devices/catalog`.
   - Hiển thị lưới thẻ (Cards) các trạm đo trong hệ thống:
     - **Thẻ `APPROVED`:** Hiện huy hiệu quyền (`Chỉ xem` hoặc `Toàn quyền điều khiển`), bấm vào để mở Dashboard giám sát chi tiết của node đó.
     - **Thẻ chưa xin quyền (`access_status == null` hoặc `REJECTED`):** Làm mờ phần số liệu, hiển thị tên trạm/vị trí và nút **"Xin quyền truy cập"** (mở modal nhỏ chọn mức quyền Xem/Điều khiển + nhập ghi chú).
     - **Thẻ `PENDING`:** Hiển thị trạng thái **"Đang chờ Admin phê duyệt"** (khóa thao tác).
   - Chỉ thực hiện `mqttClient.subscribe("iot_nhom13/{device_code}/...")` cho các `device_code` nằm trong danh sách `APPROVED` của user.

2. **Trong màn hình Dashboard chi tiết của Node:**
   - Nếu user chỉ có quyền `permission === 'VIEW'`: Ẩn hoặc vô hiệu hóa (`disabled`) cụm nút **Bật/Tắt Quạt** và form **Cập nhật ngưỡng cấu hình**, hiển thị tooltip *"Tài khoản chỉ có quyền Giám sát (VIEW)"*.

3. **Tab Quản lý Phân quyền (Dành riêng cho Role ADMIN):**
   - **Bảng 1 — Yêu cầu chờ duyệt (`PENDING`):** Hiển thị thông tin người xin, trạm xin, quyền đề xuất, lời nhắn, kèm nút **Duyệt (Xem)**, **Duyệt (Điều khiển)** và **Từ chối**.
   - **Bảng 2 — Danh sách quyền đang hoạt động (`APPROVED`):** Cho phép Admin đổi quyền nhanh giữa `VIEW` <-> `CONTROL` hoặc bấm **Thu hồi quyền**.
   - **Form Tạo tài khoản mới:** Bổ sung mục chọn đa thiết bị (checkbox chọn các node + dropdown chọn quyền `VIEW`/`CONTROL` cho từng node) khi Admin tạo user mới.