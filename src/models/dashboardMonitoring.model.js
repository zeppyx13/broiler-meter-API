const db = require("../config/db");

async function farm(id) {
  const [rows] = await db.query(
    `SELECT id, name, location_text, timezone, electricity_rate_idr_per_kwh,
       water_rate_idr_per_m3, is_active FROM farms WHERE id = ?`,
    [id],
  );
  return rows[0] || null;
}

async function live(coopId) {
  const [rows] = await db.query(
    `SELECT coop_id, device_id, flow_rate_lpm, water_total_liter, voltage_v,
       current_a, power_w, energy_kwh_total, frequency_hz, power_factor,
       phase_data_json, source, recorded_at FROM coop_live_status WHERE coop_id = ?`,
    [coopId],
  );
  return rows[0] || null;
}

async function devices(coopId) {
  const [rows] = await db.query(
    `SELECT id, coop_id, device_uid, mqtt_topic_key, name, device_type,
       firmware_version, is_active, connectivity_status, last_seen_at, created_at
     FROM devices WHERE coop_id = ? ORDER BY id`,
    [coopId],
  );
  return rows;
}

module.exports = { farm, live, devices };
