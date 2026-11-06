-- Phase 5 domain extensions. Additive and re-run-safe on MariaDB 10.4.
-- No automatic startup migration. Existing data/telemetry/cursor are not updated.
CREATE TABLE IF NOT EXISTS schema_migrations (
  version VARCHAR(80) NOT NULL PRIMARY KEY,
  checksum_sha256 CHAR(64) NOT NULL,
  applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS coop_members (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  coop_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  can_operate TINYINT(1) NOT NULL DEFAULT 0,
  relay_operate TINYINT(1) NOT NULL DEFAULT 0,
  assigned_by BIGINT UNSIGNED DEFAULT NULL,
  revoked_at DATETIME DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_coop_members_identity (coop_id,user_id),
  KEY idx_coop_members_user (user_id,revoked_at,coop_id),
  CONSTRAINT fk_coop_members_coop FOREIGN KEY (coop_id) REFERENCES coops(id) ON DELETE RESTRICT,
  CONSTRAINT fk_coop_members_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_coop_members_actor FOREIGN KEY (assigned_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS flock_cycle_profiles (
  flock_cycle_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  strain VARCHAR(100) DEFAULT NULL,
  harvest_target_days SMALLINT UNSIGNED DEFAULT NULL,
  updated_by BIGINT UNSIGNED DEFAULT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_flock_profile_cycle FOREIGN KEY (flock_cycle_id) REFERENCES flock_cycles(id) ON DELETE RESTRICT,
  CONSTRAINT fk_flock_profile_author FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS flock_daily_records (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  flock_cycle_id BIGINT UNSIGNED NOT NULL,
  record_date DATE NOT NULL,
  dead INT UNSIGNED NOT NULL DEFAULT 0,
  culled INT UNSIGNED NOT NULL DEFAULT 0,
  avg_weight_g DECIMAL(12,3) DEFAULT NULL,
  feed_kg DECIMAL(14,3) DEFAULT NULL,
  note TEXT DEFAULT NULL,
  revision INT UNSIGNED NOT NULL DEFAULT 1,
  is_void TINYINT(1) NOT NULL DEFAULT 0,
  recorded_by BIGINT UNSIGNED DEFAULT NULL,
  updated_by BIGINT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_daily_record_cycle_date (flock_cycle_id,record_date),
  CONSTRAINT fk_daily_record_cycle FOREIGN KEY (flock_cycle_id) REFERENCES flock_cycles(id) ON DELETE RESTRICT,
  CONSTRAINT fk_daily_record_author FOREIGN KEY (recorded_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_daily_record_editor FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS flock_daily_record_revisions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  daily_record_id BIGINT UNSIGNED NOT NULL,
  flock_cycle_id BIGINT UNSIGNED NOT NULL,
  revision INT UNSIGNED NOT NULL,
  request_id CHAR(36) NOT NULL,
  payload_hash CHAR(64) NOT NULL,
  operation ENUM('upsert','void') NOT NULL,
  snapshot_json LONGTEXT NOT NULL,
  recorded_by BIGINT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_daily_revision_request (flock_cycle_id,request_id),
  UNIQUE KEY uq_daily_revision_version (daily_record_id,revision),
  CONSTRAINT fk_daily_revision_record FOREIGN KEY (daily_record_id) REFERENCES flock_daily_records(id) ON DELETE RESTRICT,
  CONSTRAINT fk_daily_revision_cycle FOREIGN KEY (flock_cycle_id) REFERENCES flock_cycles(id) ON DELETE RESTRICT,
  CONSTRAINT fk_daily_revision_actor FOREIGN KEY (recorded_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS flock_daily_record_events (
  revision_id BIGINT UNSIGNED NOT NULL,
  event_id BIGINT UNSIGNED NOT NULL,
  category ENUM('mortality','culling') NOT NULL,
  PRIMARY KEY (revision_id,event_id),
  UNIQUE KEY uq_daily_event (event_id),
  CONSTRAINT fk_daily_link_revision FOREIGN KEY (revision_id) REFERENCES flock_daily_record_revisions(id) ON DELETE RESTRICT,
  CONSTRAINT fk_daily_link_event FOREIGN KEY (event_id) REFERENCES flock_events(id) ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS coop_equipment (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  coop_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(150) NOT NULL,
  type ENUM('fan','brooder','heater','light','pump','other') NOT NULL,
  count INT UNSIGNED NOT NULL DEFAULT 1,
  rated_watt DECIMAL(14,3) NOT NULL,
  unit VARCHAR(30) NOT NULL DEFAULT 'unit',
  is_expected_active TINYINT(1) NOT NULL DEFAULT 0,
  schedule_json LONGTEXT DEFAULT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  updated_by BIGINT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_equipment_coop (coop_id,is_active),
  CONSTRAINT fk_equipment_coop FOREIGN KEY (coop_id) REFERENCES coops(id) ON DELETE RESTRICT,
  CONSTRAINT fk_equipment_actor FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS domain_audit_log (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  coop_id BIGINT UNSIGNED NOT NULL,
  actor_id BIGINT UNSIGNED DEFAULT NULL,
  action VARCHAR(60) NOT NULL,
  resource_id BIGINT UNSIGNED DEFAULT NULL,
  detail_json LONGTEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_domain_audit_coop (coop_id,id),
  CONSTRAINT fk_domain_audit_coop FOREIGN KEY (coop_id) REFERENCES coops(id) ON DELETE RESTRICT,
  CONSTRAINT fk_domain_audit_actor FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS flock_harvest_requests (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  flock_cycle_id BIGINT UNSIGNED NOT NULL,
  request_id CHAR(36) NOT NULL,
  payload_hash CHAR(64) NOT NULL,
  response_json LONGTEXT NOT NULL,
  recorded_by BIGINT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_harvest_request (flock_cycle_id,request_id),
  CONSTRAINT fk_harvest_request_cycle FOREIGN KEY (flock_cycle_id) REFERENCES flock_cycles(id) ON DELETE RESTRICT,
  CONSTRAINT fk_harvest_request_actor FOREIGN KEY (recorded_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;
