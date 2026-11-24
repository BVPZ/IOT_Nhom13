-- =========================================================================
-- DATABASE SCHEMA & SEED DATA (CHUẨN MYSQL AIVEN CLOUD) - NHÓM 13
-- =========================================================================

-- 1. BẢNG NGƯỜI DÙNG & PHÂN QUYỀN (Mục 4.4a & 4.5)
CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    full_name VARCHAR(100) NOT NULL,
    role ENUM('ADMIN', 'OPERATOR', 'VIEWER') NOT NULL DEFAULT 'VIEWER',
    is_active TINYINT(1) DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 2. BẢNG QUẢN LÝ VÒNG ĐỜI THIẾT BỊ (Mục 4.4b & 4.5)
CREATE TABLE IF NOT EXISTS devices (
    id INT AUTO_INCREMENT PRIMARY KEY,
    device_code VARCHAR(50) UNIQUE NOT NULL,
    device_name VARCHAR(100) NOT NULL,
    secret_token VARCHAR(255) NOT NULL,
    location VARCHAR(100) NOT NULL,
    visibility ENUM('PUBLIC', 'PRIVATE') NOT NULL DEFAULT 'PRIVATE',
    owner_id INT,
    hardware_version VARCHAR(30) DEFAULT 'ESP32-WROOM-32',
    firmware_version VARCHAR(20) DEFAULT 'v1.0.0',
    lifecycle_status ENUM('REGISTERED', 'PROVISIONED', 'ACTIVE', 'OFFLINE', 'MAINTENANCE', 'DECOMMISSIONED') NOT NULL DEFAULT 'REGISTERED',
    is_online TINYINT(1) DEFAULT 0,
    send_interval_ms INT DEFAULT 5000,
    eco2_threshold FLOAT DEFAULT 1000.0,
    tvoc_threshold FLOAT DEFAULT 500.0,
    temp_threshold FLOAT DEFAULT 35.0,
    last_seen_at TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 3. QUYỀN TRUY CẬP THEO NODE
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

-- 4. BẢNG LƯU TRỮ DỮ LIỆU CẢM BIẾN - TELEMETRY (Mục 4.4c)
CREATE TABLE IF NOT EXISTS telemetry_logs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    device_id INT NOT NULL,
    temperature FLOAT NOT NULL,
    humidity FLOAT NOT NULL,
    eco2 INT NOT NULL,
    tvoc INT NOT NULL,
    fan_state TINYINT(1) DEFAULT 0,
    recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 5. BẢNG GIÁM SÁT & LỊCH SỬ CẢNH BÁO (Mục 4.4d)
CREATE TABLE IF NOT EXISTS alerts (
    id INT AUTO_INCREMENT PRIMARY KEY,
    device_id INT NOT NULL,
    alert_type VARCHAR(50) NOT NULL,
    severity ENUM('INFO', 'WARNING', 'CRITICAL') NOT NULL DEFAULT 'WARNING',
    message TEXT NOT NULL,
    measured_value FLOAT,
    threshold_value FLOAT,
    status ENUM('NEW', 'ACKNOWLEDGED', 'RESOLVED') DEFAULT 'NEW',
    acknowledged_by INT NULL,
    acknowledged_at TIMESTAMP NULL,
    resolve_note TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
    FOREIGN KEY (acknowledged_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 6. BẢNG LỊCH SỬ ĐIỀU KHIỂN & PHẢN HỒI - COMMAND & ACK (Mục 4.4e)
CREATE TABLE IF NOT EXISTS command_logs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    cmd_code VARCHAR(50) UNIQUE NOT NULL,
    device_id INT NOT NULL,
    issued_by INT NOT NULL,
    target_actuator VARCHAR(50) NOT NULL,
    command_action VARCHAR(50) NOT NULL,
    payload_json TEXT,
    status ENUM('PENDING', 'SUCCESS', 'FAILED', 'TIMEOUT') DEFAULT 'PENDING',
    ack_message TEXT,
    issued_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    acked_at TIMESTAMP NULL,
    FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
    FOREIGN KEY (issued_by) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 7. BẢNG NHẬT KÝ BẢO MẬT - AUDIT LOGS (Mục 4.5)
CREATE TABLE IF NOT EXISTS audit_logs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NULL,
    action VARCHAR(100) NOT NULL,
    target_entity VARCHAR(50),
    details TEXT,
    ip_address VARCHAR(45),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
