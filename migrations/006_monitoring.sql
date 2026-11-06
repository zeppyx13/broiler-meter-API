-- Phase 5 monitoring additions. Apply explicitly after backup/preflight; never on startup.
-- No legacy tables, counters, users, credentials or device mappings are modified.
CREATE TABLE IF NOT EXISTS telemetry_samples (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  coop_id BIGINT UNSIGNED NOT NULL,
  device_id BIGINT UNSIGNED NOT NULL,
  source ENUM('real','simulation') NOT NULL,
  sample_bucket DATETIME NOT NULL,
  recorded_at DATETIME(3) NOT NULL,
  received_at DATETIME(3) NOT NULL,
  fields_json LONGTEXT NOT NULL,
  quality_json LONGTEXT NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_telemetry_sample_device_source_bucket (device_id,source,sample_bucket),
  KEY idx_telemetry_samples_coop_source_time (coop_id,source,recorded_at),
  KEY idx_telemetry_samples_retention (received_at),
  CONSTRAINT fk_telemetry_samples_coop FOREIGN KEY (coop_id) REFERENCES coops(id) ON DELETE CASCADE,
  CONSTRAINT fk_telemetry_samples_device FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
  CONSTRAINT chk_telemetry_fields_json CHECK (JSON_VALID(fields_json)),
  CONSTRAINT chk_telemetry_quality_json CHECK (JSON_VALID(quality_json))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS device_diagnostic_entries (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  coop_id BIGINT UNSIGNED NOT NULL,
  device_id BIGINT UNSIGNED NOT NULL,
  level ENUM('info','warning','error') NOT NULL,
  code VARCHAR(60) NOT NULL,
  message VARCHAR(255) NOT NULL,
  source ENUM('real','simulation') NOT NULL,
  recorded_at DATETIME(3) NOT NULL,
  received_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_diagnostic_coop_received (coop_id,received_at,id),
  KEY idx_diagnostic_retention (received_at),
  CONSTRAINT fk_diagnostic_coop FOREIGN KEY (coop_id) REFERENCES coops(id) ON DELETE CASCADE,
  CONSTRAINT fk_diagnostic_device FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sensor_calibrations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  coop_id BIGINT UNSIGNED NOT NULL,
  device_id BIGINT UNSIGNED DEFAULT NULL,
  type ENUM('water','electricity') NOT NULL,
  reference_value DECIMAL(18,6) NOT NULL,
  sensor_value DECIMAL(18,6) NOT NULL,
  unit ENUM('L','W') NOT NULL,
  instrument_id VARCHAR(120) NOT NULL,
  method VARCHAR(500) NOT NULL,
  measured_at DATETIME(3) NOT NULL,
  source ENUM('real','simulation') NOT NULL,
  note VARCHAR(1000) DEFAULT NULL,
  recorded_by BIGINT UNSIGNED NOT NULL,
  verification_state ENUM('manual_recorded','independently_verified') NOT NULL DEFAULT 'manual_recorded',
  verified_by BIGINT UNSIGNED DEFAULT NULL,
  verified_at DATETIME(3) DEFAULT NULL,
  evidence_note VARCHAR(1000) DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_calibration_coop_source_time (coop_id,source,measured_at,id),
  CONSTRAINT fk_calibration_coop FOREIGN KEY (coop_id) REFERENCES coops(id) ON DELETE RESTRICT,
  CONSTRAINT fk_calibration_device FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE RESTRICT,
  CONSTRAINT fk_calibration_recorder FOREIGN KEY (recorded_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_calibration_verifier FOREIGN KEY (verified_by) REFERENCES users(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS field_validation_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  coop_id BIGINT UNSIGNED NOT NULL,
  kind ENUM('packet_delivery','guard_response','field_trial') NOT NULL,
  source ENUM('real','simulation') NOT NULL,
  instrument_id VARCHAR(120) NOT NULL,
  method VARCHAR(1000) NOT NULL,
  observed_start DATETIME(3) NOT NULL,
  observed_end DATETIME(3) NOT NULL,
  evidence_json LONGTEXT NOT NULL,
  recorded_by BIGINT UNSIGNED NOT NULL,
  verification_state ENUM('manual_recorded','independently_verified') NOT NULL DEFAULT 'manual_recorded',
  verified_by BIGINT UNSIGNED DEFAULT NULL,
  verified_at DATETIME(3) DEFAULT NULL,
  evidence_note VARCHAR(1000) DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_field_validation_coop_source (coop_id,source,observed_start,id),
  CONSTRAINT fk_field_validation_coop FOREIGN KEY (coop_id) REFERENCES coops(id) ON DELETE RESTRICT,
  CONSTRAINT fk_field_validation_recorder FOREIGN KEY (recorded_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_field_validation_verifier FOREIGN KEY (verified_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_field_validation_evidence CHECK (JSON_VALID(evidence_json))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS maintenance_requests (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  coop_id BIGINT UNSIGNED NOT NULL,
  device_id BIGINT UNSIGNED NOT NULL,
  requested_by BIGINT UNSIGNED NOT NULL,
  request_id CHAR(36) NOT NULL,
  command ENUM('status','sync_ntp','reboot','clear_buf','reset_nvs') NOT NULL,
  reason VARCHAR(500) NOT NULL,
  status ENUM('blocked_hardware_acceptance') NOT NULL DEFAULT 'blocked_hardware_acceptance',
  requested_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_maintenance_actor_request (requested_by,request_id),
  KEY idx_maintenance_coop (coop_id,requested_at),
  CONSTRAINT fk_maintenance_coop FOREIGN KEY (coop_id) REFERENCES coops(id) ON DELETE RESTRICT,
  CONSTRAINT fk_maintenance_device FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE RESTRICT,
  CONSTRAINT fk_maintenance_actor FOREIGN KEY (requested_by) REFERENCES users(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
