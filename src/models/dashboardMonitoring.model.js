const db = require("../config/db");
const provenance = require("./deviceProvenance");

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
       phase_data_json, source, recorded_at FROM coop_live_status WHERE coop_id = ? AND source = 'sensor'`,
    [coopId],
  );
  return rows[0] || null;
}

async function devices(coopId) {
  const [rows] = await db.query(
    `SELECT d.id, d.coop_id, d.device_uid, d.mqtt_topic_key, d.name, d.device_type,
       d.firmware_version, d.is_active, d.connectivity_status, d.last_seen_at, d.created_at,
       ${provenance}
     FROM devices d WHERE d.coop_id = ? ORDER BY d.id`,
    [coopId],
  );
  return rows;
}

module.exports = { farm, live, devices };
