-- ADDITIVE, IDEMPOTENT, NOT APPLIED. Requires reviewed migrations 005/006.
-- No acceptance is granted by this migration. Existing request rows remain unchanged.
CREATE TABLE IF NOT EXISTS maintenance_request_details (
  maintenance_request_id BIGINT UNSIGNED NOT NULL,
  payload_hash CHAR(64) NOT NULL,
  target_fingerprint CHAR(64) NOT NULL,
  status VARCHAR(24) NOT NULL,
  http_status SMALLINT UNSIGNED NOT NULL,
  preflight_json LONGTEXT NOT NULL,
  accepted_at DATETIME(3) NOT NULL,
  publish_attempted_at DATETIME(3) DEFAULT NULL,
  published_at DATETIME(3) DEFAULT NULL,
  timeout_at DATETIME(3) DEFAULT NULL,
  completed_at DATETIME(3) DEFAULT NULL,
  failure_reason VARCHAR(500) DEFAULT NULL,
  observation_json LONGTEXT DEFAULT NULL,
  PRIMARY KEY (maintenance_request_id),
  KEY idx_maintenance_details_pending (status,timeout_at),
  CONSTRAINT fk_maintenance_details_request FOREIGN KEY (maintenance_request_id) REFERENCES maintenance_requests(id) ON DELETE RESTRICT,
  CONSTRAINT chk_maintenance_preflight CHECK (JSON_VALID(preflight_json)),
  CONSTRAINT chk_maintenance_observation CHECK (observation_json IS NULL OR JSON_VALID(observation_json))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS maintenance_acceptance_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  coop_id BIGINT UNSIGNED NOT NULL,
  device_id BIGINT UNSIGNED NOT NULL,
  command ENUM('status','sync_ntp','reboot','clear_buf','reset_nvs') NOT NULL,
  accepted TINYINT(1) NOT NULL,
  target_fingerprint CHAR(64) NOT NULL,
  actor_id BIGINT UNSIGNED NOT NULL,
  request_id CHAR(36) NOT NULL,
  payload_hash CHAR(64) NOT NULL,
  evidence_reference VARCHAR(255) NOT NULL,
  note VARCHAR(1000) NOT NULL,
  recorded_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_maintenance_acceptance_replay (actor_id,request_id),
  KEY idx_maintenance_acceptance_target (device_id,command,id),
  CONSTRAINT fk_maintenance_acceptance_coop FOREIGN KEY (coop_id) REFERENCES coops(id) ON DELETE RESTRICT,
  CONSTRAINT fk_maintenance_acceptance_device FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE RESTRICT,
  CONSTRAINT fk_maintenance_acceptance_actor FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
