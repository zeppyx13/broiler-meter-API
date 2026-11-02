-- COASTHER BROILER DATABASE SCHEMA v1.0
-- Target: MariaDB 10.4+ / MySQL 8.0+ (InnoDB, utf8mb4)
-- Designed from legacy coasther.sql and COASTHER Broiler proposal, 2026-11-03
-- Schema-only: NO legacy user records, passwords, payment information, or sample telemetry.
-- IMPORTANT: Run only against a NEW development database; review before executing.
-- DO NOT point the old (kost) backend to this database until its queries are adapted.
-- Database times (DATETIME/TIMESTAMP): store UTC; convert to farm timezone in backend.
-- Consistent readings: WATER = liters; ELECTRICITY = kWh; POWER = watts.
-- NO DROP DATABASE/TABLE, TRUNCATE or DELETE commands in this file.

CREATE DATABASE IF NOT EXISTS `coasther_broiler`
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE `coasther_broiler`;

-- 01. Accounts: preserve legacy auth/OTP/FCM column names for code reuse.
-- NOTE: role ENUM deliberately changes tenant -> operator; adapt auth/services.
CREATE TABLE `users` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(120) NOT NULL,
  `email` VARCHAR(190) NOT NULL,
  `password_hash` VARCHAR(255) NOT NULL,
  `role` ENUM('admin','manager','operator') NOT NULL DEFAULT 'operator',
  `phone` VARCHAR(30) DEFAULT NULL,
  `avatar_url` VARCHAR(500) DEFAULT NULL,
  `is_verified` TINYINT(1) NOT NULL DEFAULT 0,
  `reset_otp_hash` VARCHAR(64) DEFAULT NULL,
  `reset_otp_expires_at` DATETIME DEFAULT NULL,
  `reset_otp_attempts` TINYINT UNSIGNED NOT NULL DEFAULT 0,
  `reset_otp_sent_at` DATETIME DEFAULT NULL,
  `delete_otp_hash` VARCHAR(64) DEFAULT NULL,
  `delete_otp_expires_at` DATETIME DEFAULT NULL,
  `delete_otp_attempts` TINYINT UNSIGNED NOT NULL DEFAULT 0,
  `delete_otp_sent_at` DATETIME DEFAULT NULL,
  `fcm_token` VARCHAR(255) DEFAULT NULL,
  `default_coop_id` BIGINT UNSIGNED DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_users_email` (`email`),
  KEY `idx_users_role` (`role`),
  KEY `idx_users_default_coop` (`default_coop_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 02. Farms: resource-cost settings live at farm level, not rental/billing level.
CREATE TABLE `farms` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `owner_user_id` BIGINT UNSIGNED NOT NULL,
  `name` VARCHAR(150) NOT NULL,
  `location_text` VARCHAR(255) DEFAULT NULL,
  `timezone` VARCHAR(64) NOT NULL DEFAULT 'Asia/Makassar',
  `electricity_rate_idr_per_kwh` DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  `water_rate_idr_per_m3` DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_farms_owner` (`owner_user_id`),
  CONSTRAINT `fk_farms_owner` FOREIGN KEY (`owner_user_id`) REFERENCES `users` (`id`)
    ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 03. Access within a farm; independent of global users.role.
CREATE TABLE `farm_members` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `farm_id` BIGINT UNSIGNED NOT NULL,
  `user_id` BIGINT UNSIGNED NOT NULL,
  `role` ENUM('owner','manager','operator','viewer') NOT NULL DEFAULT 'operator',
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_farm_members_farm_user` (`farm_id`,`user_id`),
  KEY `idx_farm_members_user` (`user_id`),
  CONSTRAINT `fk_farm_members_farm` FOREIGN KEY (`farm_id`) REFERENCES `farms` (`id`)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT `fk_farm_members_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)
    ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 04. Coops: main business unit; dashboard loads user's default accessible coop.
CREATE TABLE `coops` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `farm_id` BIGINT UNSIGNED NOT NULL,
  `code` VARCHAR(40) NOT NULL,
  `name` VARCHAR(150) NOT NULL,
  `capacity_birds` INT UNSIGNED DEFAULT NULL,
  `description` TEXT DEFAULT NULL,
  `status` ENUM('active','inactive') NOT NULL DEFAULT 'active',
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_coops_farm_code` (`farm_id`,`code`),
  KEY `idx_coops_farm_status` (`farm_id`,`status`),
  CONSTRAINT `fk_coops_farm` FOREIGN KEY (`farm_id`) REFERENCES `farms` (`id`)
    ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A nullable default coop supports login -> dashboard without a coop picker.
-- Backend must verify this coop belongs to a farm accessible by the user.
ALTER TABLE `users`
  ADD CONSTRAINT `fk_users_default_coop` FOREIGN KEY (`default_coop_id`) REFERENCES `coops` (`id`)
    ON UPDATE CASCADE ON DELETE SET NULL;

-- 05. Broiler production cycles. Age is derived in farm-local calendar days:
-- day_age = DATEDIFF(local_date, placement_date) + 1.
-- Invariant: at most one 'active' cycle per coop, enforce in transactional service.
CREATE TABLE `flock_cycles` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `coop_id` BIGINT UNSIGNED NOT NULL,
  `cycle_code` VARCHAR(60) NOT NULL,
  `placement_date` DATE NOT NULL,
  `planned_harvest_date` DATE DEFAULT NULL,
  `actual_harvest_date` DATE DEFAULT NULL,
  `initial_population` INT UNSIGNED NOT NULL,
  `current_population` INT UNSIGNED NOT NULL,
  `status` ENUM('planned','active','completed','cancelled') NOT NULL DEFAULT 'planned',
  `notes` TEXT DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_flock_cycles_coop_code` (`coop_id`,`cycle_code`),
  KEY `idx_flock_cycles_coop_status` (`coop_id`,`status`),
  KEY `idx_flock_cycles_placement` (`placement_date`),
  CONSTRAINT `fk_flock_cycles_coop` FOREIGN KEY (`coop_id`) REFERENCES `coops` (`id`)
    ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 06. Bird-count events: signed population_change; deaths/culls/harvests negative.
-- Update flock_cycles.current_population in the SAME DB transaction.
CREATE TABLE `flock_events` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `flock_cycle_id` BIGINT UNSIGNED NOT NULL,
  `event_type` ENUM('mortality','culling','adjustment','harvest') NOT NULL,
  `population_change` INT NOT NULL,
  `event_date` DATE NOT NULL,
  `notes` VARCHAR(255) DEFAULT NULL,
  `recorded_by` BIGINT UNSIGNED DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_flock_events_cycle_date` (`flock_cycle_id`,`event_date`),
  KEY `idx_flock_events_author` (`recorded_by`),
  CONSTRAINT `fk_flock_events_cycle` FOREIGN KEY (`flock_cycle_id`) REFERENCES `flock_cycles` (`id`)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT `fk_flock_events_author` FOREIGN KEY (`recorded_by`) REFERENCES `users` (`id`)
    ON UPDATE CASCADE ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 07. Physical ESP32: mqtt_topic_key stays independent of coop_id/DB id.
-- This allows legacy firmware topic keys (e.g. room1) during backend adaptation.
CREATE TABLE `devices` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `coop_id` BIGINT UNSIGNED NOT NULL,
  `device_uid` VARCHAR(120) NOT NULL,
  `mqtt_topic_key` VARCHAR(120) NOT NULL,
  `name` VARCHAR(120) NOT NULL,
  `device_type` ENUM('esp32','gateway','other') NOT NULL DEFAULT 'esp32',
  `firmware_version` VARCHAR(60) DEFAULT NULL,
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `connectivity_status` ENUM('unknown','online','offline') NOT NULL DEFAULT 'unknown',
  `last_seen_at` DATETIME DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_devices_uid` (`device_uid`),
  UNIQUE KEY `uq_devices_mqtt_topic_key` (`mqtt_topic_key`),
  KEY `idx_devices_coop` (`coop_id`),
  KEY `idx_devices_seen` (`last_seen_at`),
  CONSTRAINT `fk_devices_coop` FOREIGN KEY (`coop_id`) REFERENCES `coops` (`id`)
    ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 08. Logical meter channels attached to a physical device.
-- meter_uid maps legacy coasther/meter/{meter_uid}/reading topics.
-- For 3-phase electricity, create multiple meters with distinct channels.
CREATE TABLE `meters` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `device_id` BIGINT UNSIGNED NOT NULL,
  `meter_uid` VARCHAR(120) NOT NULL,
  `type` ENUM('water','electricity') NOT NULL,
  `channel` VARCHAR(40) NOT NULL DEFAULT 'main',
  `unit` ENUM('liter','kwh') NOT NULL,
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `installed_at` DATETIME DEFAULT NULL,
  `last_reading_value` DECIMAL(18,6) DEFAULT NULL,
  `last_reading_at` DATETIME DEFAULT NULL,
  `counter_epoch` INT UNSIGNED NOT NULL DEFAULT 0,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_meters_uid` (`meter_uid`),
  UNIQUE KEY `uq_meters_device_channel` (`device_id`,`type`,`channel`),
  CONSTRAINT `fk_meters_device` FOREIGN KEY (`device_id`) REFERENCES `devices` (`id`)
    ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 09. Historical cumulative readings. coop/cycle are historical snapshots.
-- delta_value is calculated only for accepted ordered readings; zero at baselines.
-- source='simulation' permits clearly labeled demo data, never disguised as sensor data.
CREATE TABLE `meter_readings` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `meter_id` BIGINT UNSIGNED NOT NULL,
  `coop_id` BIGINT UNSIGNED NOT NULL,
  `flock_cycle_id` BIGINT UNSIGNED DEFAULT NULL,
  `reading_value` DECIMAL(18,6) NOT NULL,
  `delta_value` DECIMAL(18,6) DEFAULT NULL,
  `counter_epoch` INT UNSIGNED NOT NULL DEFAULT 0,
  `reading_status` ENUM('accepted','baseline','reset','out_of_order','suspect') NOT NULL DEFAULT 'accepted',
  `source` ENUM('mqtt','http','simulation') NOT NULL DEFAULT 'mqtt',
  `message_id` VARCHAR(120) DEFAULT NULL,
  `recorded_at` DATETIME NOT NULL,
  `received_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_meter_readings_message` (`meter_id`,`message_id`),
  KEY `idx_meter_readings_meter_time` (`meter_id`,`recorded_at`),
  KEY `idx_meter_readings_coop_time` (`coop_id`,`recorded_at`),
  KEY `idx_meter_readings_cycle_time` (`flock_cycle_id`,`recorded_at`),
  CONSTRAINT `fk_meter_readings_meter` FOREIGN KEY (`meter_id`) REFERENCES `meters` (`id`)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT `fk_meter_readings_coop` FOREIGN KEY (`coop_id`) REFERENCES `coops` (`id`)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT `fk_meter_readings_cycle` FOREIGN KEY (`flock_cycle_id`) REFERENCES `flock_cycles` (`id`)
    ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 10. Latest coop telemetry snapshot for dashboard (not historical series).
-- phase_data_json is optional structured extension for 3-phase measurements.
CREATE TABLE `coop_live_status` (
  `coop_id` BIGINT UNSIGNED NOT NULL,
  `device_id` BIGINT UNSIGNED DEFAULT NULL,
  `flow_rate_lpm` DECIMAL(12,3) DEFAULT NULL,
  `water_total_liter` DECIMAL(18,6) DEFAULT NULL,
  `voltage_v` DECIMAL(12,3) DEFAULT NULL,
  `current_a` DECIMAL(12,4) DEFAULT NULL,
  `power_w` DECIMAL(14,3) DEFAULT NULL,
  `energy_kwh_total` DECIMAL(18,6) DEFAULT NULL,
  `frequency_hz` DECIMAL(8,3) DEFAULT NULL,
  `power_factor` DECIMAL(5,3) DEFAULT NULL,
  `phase_data_json` LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL,
  `source` ENUM('sensor','simulation') NOT NULL DEFAULT 'sensor',
  `recorded_at` DATETIME DEFAULT NULL,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`coop_id`),
  KEY `idx_coop_live_status_device` (`device_id`),
  CONSTRAINT `chk_coop_live_phase_json` CHECK (`phase_data_json` IS NULL OR JSON_VALID(`phase_data_json`)),
  CONSTRAINT `fk_coop_live_status_coop` FOREIGN KEY (`coop_id`) REFERENCES `coops` (`id`)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT `fk_coop_live_status_device` FOREIGN KEY (`device_id`) REFERENCES `devices` (`id`)
    ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 11. Per-day, per-flock summary. Populate from accepted meter deltas.
-- Daily normalization uses the bird population basis defined by the aggregator.
CREATE TABLE `daily_coop_metrics` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `coop_id` BIGINT UNSIGNED NOT NULL,
  `flock_cycle_id` BIGINT UNSIGNED NOT NULL,
  `metric_date` DATE NOT NULL,
  `day_age` SMALLINT UNSIGNED NOT NULL,
  `population_basis` INT UNSIGNED NOT NULL,
  `water_liters` DECIMAL(18,4) NOT NULL DEFAULT 0.0000,
  `energy_kwh` DECIMAL(18,6) NOT NULL DEFAULT 0.000000,
  `water_liters_per_bird` DECIMAL(18,6) DEFAULT NULL,
  `energy_wh_per_bird` DECIMAL(18,4) DEFAULT NULL,
  `electricity_cost_idr` DECIMAL(16,2) NOT NULL DEFAULT 0.00,
  `data_quality` ENUM('partial','complete','simulated') NOT NULL DEFAULT 'partial',
  `computed_at` DATETIME DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_daily_metrics_cycle_date` (`flock_cycle_id`,`metric_date`),
  KEY `idx_daily_metrics_coop_date` (`coop_id`,`metric_date`),
  CONSTRAINT `fk_daily_metrics_coop` FOREIGN KEY (`coop_id`) REFERENCES `coops` (`id`)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT `fk_daily_metrics_cycle` FOREIGN KEY (`flock_cycle_id`) REFERENCES `flock_cycles` (`id`)
    ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 12. Configurable Guard thresholds and patterns by coop.
CREATE TABLE `alert_rules` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `coop_id` BIGINT UNSIGNED NOT NULL,
  `rule_code` VARCHAR(80) NOT NULL,
  `name` VARCHAR(150) NOT NULL,
  `severity` ENUM('info','warning','critical') NOT NULL DEFAULT 'warning',
  `parameters_json` LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `evaluation_window_sec` INT UNSIGNED NOT NULL DEFAULT 60,
  `cooldown_sec` INT UNSIGNED NOT NULL DEFAULT 900,
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_alert_rules_coop_code` (`coop_id`,`rule_code`),
  CONSTRAINT `chk_alert_rules_parameters` CHECK (JSON_VALID(`parameters_json`)),
  CONSTRAINT `fk_alert_rules_coop` FOREIGN KEY (`coop_id`) REFERENCES `coops` (`id`)
    ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 13. Guard events. Suspected conditions should be named 'suspected', not confirmed.
CREATE TABLE `alerts` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `coop_id` BIGINT UNSIGNED NOT NULL,
  `flock_cycle_id` BIGINT UNSIGNED DEFAULT NULL,
  `device_id` BIGINT UNSIGNED DEFAULT NULL,
  `alert_rule_id` BIGINT UNSIGNED DEFAULT NULL,
  `alert_type` VARCHAR(80) NOT NULL,
  `severity` ENUM('info','warning','critical') NOT NULL,
  `status` ENUM('active','acknowledged','resolved') NOT NULL DEFAULT 'active',
  `title` VARCHAR(160) NOT NULL,
  `message` TEXT NOT NULL,
  `evidence_json` LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL,
  `dedupe_key` VARCHAR(160) DEFAULT NULL,
  `source` ENUM('rule','manual','simulation') NOT NULL DEFAULT 'rule',
  `detected_at` DATETIME NOT NULL,
  `acknowledged_by` BIGINT UNSIGNED DEFAULT NULL,
  `acknowledged_at` DATETIME DEFAULT NULL,
  `resolved_at` DATETIME DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_alerts_coop_status_date` (`coop_id`,`status`,`detected_at`),
  KEY `idx_alerts_cycle` (`flock_cycle_id`),
  KEY `idx_alerts_dedupe` (`dedupe_key`,`status`),
  CONSTRAINT `chk_alerts_evidence_json` CHECK (`evidence_json` IS NULL OR JSON_VALID(`evidence_json`)),
  CONSTRAINT `fk_alerts_coop` FOREIGN KEY (`coop_id`) REFERENCES `coops` (`id`)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT `fk_alerts_cycle` FOREIGN KEY (`flock_cycle_id`) REFERENCES `flock_cycles` (`id`)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT `fk_alerts_device` FOREIGN KEY (`device_id`) REFERENCES `devices` (`id`)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT `fk_alerts_rule` FOREIGN KEY (`alert_rule_id`) REFERENCES `alert_rules` (`id`)
    ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT `fk_alerts_ack_user` FOREIGN KEY (`acknowledged_by`) REFERENCES `users` (`id`)
    ON UPDATE CASCADE ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 14. In-app notifications and audit of FCM/email delivery attempts.
CREATE TABLE `notifications` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` BIGINT UNSIGNED NOT NULL,
  `alert_id` BIGINT UNSIGNED DEFAULT NULL,
  `channel` ENUM('in_app','fcm','email') NOT NULL DEFAULT 'in_app',
  `title` VARCHAR(160) NOT NULL,
  `body` TEXT NOT NULL,
  `delivery_status` ENUM('pending','sent','failed') NOT NULL DEFAULT 'pending',
  `error_message` VARCHAR(500) DEFAULT NULL,
  `sent_at` DATETIME DEFAULT NULL,
  `read_at` DATETIME DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_notifications_user_read` (`user_id`,`read_at`),
  KEY `idx_notifications_alert` (`alert_id`),
  CONSTRAINT `fk_notifications_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT `fk_notifications_alert` FOREIGN KEY (`alert_id`) REFERENCES `alerts` (`id`)
    ON UPDATE CASCADE ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 15. Relay outputs for lamp/heater (NOT a climate controller replacement).
CREATE TABLE `relays` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `device_id` BIGINT UNSIGNED NOT NULL,
  `channel` SMALLINT UNSIGNED NOT NULL,
  `name` VARCHAR(100) NOT NULL,
  `purpose` ENUM('light','heater','other') NOT NULL DEFAULT 'other',
  `is_enabled` TINYINT(1) NOT NULL DEFAULT 1,
  `desired_state` ENUM('unknown','on','off') NOT NULL DEFAULT 'unknown',
  `reported_state` ENUM('unknown','on','off') NOT NULL DEFAULT 'unknown',
  `last_reported_at` DATETIME DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_relays_device_channel` (`device_id`,`channel`),
  CONSTRAINT `fk_relays_device` FOREIGN KEY (`device_id`) REFERENCES `devices` (`id`)
    ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 16. Relay command state machine. MQTT PUBACK != device ACK != physical proof.
CREATE TABLE `relay_commands` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `relay_id` BIGINT UNSIGNED NOT NULL,
  `requested_by` BIGINT UNSIGNED DEFAULT NULL,
  `correlation_id` CHAR(36) NOT NULL,
  `command` ENUM('on','off') NOT NULL,
  `status` ENUM('queued','published','device_acked','timed_out','failed') NOT NULL DEFAULT 'queued',
  `source` ENUM('manual','simulation') NOT NULL DEFAULT 'manual',
  `requested_at` DATETIME NOT NULL,
  `published_at` DATETIME DEFAULT NULL,
  `acked_at` DATETIME DEFAULT NULL,
  `failure_reason` VARCHAR(500) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_relay_commands_correlation` (`correlation_id`),
  KEY `idx_relay_commands_relay_time` (`relay_id`,`requested_at`),
  CONSTRAINT `fk_relay_commands_relay` FOREIGN KEY (`relay_id`) REFERENCES `relays` (`id`)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT `fk_relay_commands_user` FOREIGN KEY (`requested_by`) REFERENCES `users` (`id`)
    ON UPDATE CASCADE ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 17. Forecast values (next day or remaining to harvest).
-- prediction details/method/confidence make provenance explicit.
CREATE TABLE `forecasts` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `coop_id` BIGINT UNSIGNED NOT NULL,
  `flock_cycle_id` BIGINT UNSIGNED NOT NULL,
  `metric` ENUM('water_liters','energy_kwh','electricity_cost_idr') NOT NULL,
  `horizon` ENUM('next_day','until_harvest') NOT NULL,
  `target_date` DATE DEFAULT NULL,
  `predicted_value` DECIMAL(18,4) NOT NULL,
  `method` ENUM('moving_average','rule_based','regression') NOT NULL DEFAULT 'moving_average',
  `confidence` ENUM('low','medium','high') NOT NULL DEFAULT 'low',
  `input_days` SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `details_json` LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL,
  `is_simulated` TINYINT(1) NOT NULL DEFAULT 0,
  `generated_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_forecasts_cycle_metric_time` (`flock_cycle_id`,`metric`,`generated_at`),
  CONSTRAINT `chk_forecasts_details_json` CHECK (`details_json` IS NULL OR JSON_VALID(`details_json`)),
  CONSTRAINT `fk_forecasts_coop` FOREIGN KEY (`coop_id`) REFERENCES `coops` (`id`)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT `fk_forecasts_cycle` FOREIGN KEY (`flock_cycle_id`) REFERENCES `flock_cycles` (`id`)
    ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 18. Eco-Advisor recommendations, deterministic or assisted by Gemini.
CREATE TABLE `eco_recommendations` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `coop_id` BIGINT UNSIGNED NOT NULL,
  `flock_cycle_id` BIGINT UNSIGNED DEFAULT NULL,
  `category` ENUM('water','electricity','operations') NOT NULL,
  `priority` ENUM('low','medium','high') NOT NULL DEFAULT 'medium',
  `title` VARCHAR(160) NOT NULL,
  `description` TEXT NOT NULL,
  `estimated_savings_idr` DECIMAL(16,2) DEFAULT NULL,
  `evidence_json` LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL,
  `source` ENUM('rule','gemini','simulation') NOT NULL DEFAULT 'rule',
  `status` ENUM('new','accepted','dismissed') NOT NULL DEFAULT 'new',
  `generated_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_eco_recommendations_coop_time` (`coop_id`,`generated_at`),
  CONSTRAINT `chk_eco_recommendations_evidence` CHECK (`evidence_json` IS NULL OR JSON_VALID(`evidence_json`)),
  CONSTRAINT `fk_eco_recommendations_coop` FOREIGN KEY (`coop_id`) REFERENCES `coops` (`id`)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT `fk_eco_recommendations_cycle` FOREIGN KEY (`flock_cycle_id`) REFERENCES `flock_cycles` (`id`)
    ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 19. Conversational Gemini Copilot sessions.
CREATE TABLE `ai_conversations` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` BIGINT UNSIGNED NOT NULL,
  `coop_id` BIGINT UNSIGNED NOT NULL,
  `flock_cycle_id` BIGINT UNSIGNED DEFAULT NULL,
  `title` VARCHAR(160) DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_ai_conversations_user_time` (`user_id`,`created_at`),
  CONSTRAINT `fk_ai_conversations_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT `fk_ai_conversations_coop` FOREIGN KEY (`coop_id`) REFERENCES `coops` (`id`)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT `fk_ai_conversations_cycle` FOREIGN KEY (`flock_cycle_id`) REFERENCES `flock_cycles` (`id`)
    ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 20. Individual Copilot messages; context_json may store non-sensitive references.
CREATE TABLE `ai_messages` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `conversation_id` BIGINT UNSIGNED NOT NULL,
  `role` ENUM('user','assistant','system') NOT NULL,
  `content` LONGTEXT NOT NULL,
  `context_json` LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_ai_messages_conversation_time` (`conversation_id`,`created_at`),
  CONSTRAINT `chk_ai_messages_context` CHECK (`context_json` IS NULL OR JSON_VALID(`context_json`)),
  CONSTRAINT `fk_ai_messages_conversation` FOREIGN KEY (`conversation_id`) REFERENCES `ai_conversations` (`id`)
    ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 21. AI cache: preserve legacy reuse pattern, replace room_id with coop_id.
CREATE TABLE `ai_cache` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `coop_id` BIGINT UNSIGNED NOT NULL,
  `flock_cycle_id` BIGINT UNSIGNED DEFAULT NULL,
  `type` ENUM('insight','prediction','advisor','copilot_context') NOT NULL,
  `cache_key` VARCHAR(190) NOT NULL,
  `result_json` LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `generated_at` DATETIME NOT NULL,
  `expires_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_ai_cache_key` (`cache_key`),
  KEY `idx_ai_cache_coop_expiry` (`coop_id`,`expires_at`),
  CONSTRAINT `chk_ai_cache_result` CHECK (JSON_VALID(`result_json`)),
  CONSTRAINT `fk_ai_cache_coop` FOREIGN KEY (`coop_id`) REFERENCES `coops` (`id`)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT `fk_ai_cache_cycle` FOREIGN KEY (`flock_cycle_id`) REFERENCES `flock_cycles` (`id`)
    ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- No legacy room / tenant / lease / invoice / payment / Midtrans tables.
-- No real telemetry or human accounts seeded: use onboarding API or explicitly
-- labeled development fixtures. Do not insert simulated measurements as real.
