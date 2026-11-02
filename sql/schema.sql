CREATE DATABASE IF NOT EXISTS ttn_dashboard CHARACTER SET utf8mb4;
USE ttn_dashboard;

CREATE TABLE IF NOT EXISTS ttn_uplinks (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    application_id VARCHAR(100) NOT NULL,
    device_id VARCHAR(100) NOT NULL,
    session_id VARCHAR(100) NOT NULL,
    frame_counter BIGINT UNSIGNED NOT NULL,
    fport TINYINT UNSIGNED NOT NULL,
    ttn_received_at VARCHAR(40) NOT NULL,
    decoded_payload JSON NOT NULL,
    stored_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    CONSTRAINT valid_fport CHECK (fport BETWEEN 1 AND 223),
    CONSTRAINT decoded_object CHECK (JSON_TYPE(decoded_payload) = 'OBJECT'),
    UNIQUE KEY uplink_identity (application_id, device_id, session_id, frame_counter, fport),
    INDEX device_port_time (application_id, device_id, fport, ttn_received_at)
);

-- Mock development credentials only. Use a protected local configuration in deployment.
CREATE USER IF NOT EXISTS 'dashboard_store'@'localhost' IDENTIFIED BY 'mock-store-password';
CREATE USER IF NOT EXISTS 'dashboard_reader'@'localhost' IDENTIFIED BY 'mock-reader-password';
GRANT CREATE, INSERT, SELECT, INDEX ON ttn_dashboard.* TO 'dashboard_store'@'localhost';
GRANT SELECT ON ttn_dashboard.ttn_uplinks TO 'dashboard_reader'@'localhost';
