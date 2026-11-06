const db = require("../config/db");

async function coopLocation(id) {
  const [[row]] = await db.query("SELECT farm_id FROM coops WHERE id = ?", [
    id,
  ]);
  return row || null;
}

async function farm(id, connection) {
  const [[row]] = await connection.query(
    `SELECT id, name, timezone, is_active, electricity_rate_idr_per_kwh, water_rate_idr_per_m3
     FROM farms WHERE id = ?`,
    [id],
  );
  return row || null;
}

async function activeCycle(coopId, connection) {
  const [[row]] = await connection.query(
    `SELECT id, coop_id, cycle_code, initial_population, current_population, status,
       DATE_FORMAT(placement_date, '%Y-%m-%d') AS placement_date,
       DATE_FORMAT(planned_harvest_date, '%Y-%m-%d') AS planned_harvest_date,
       DATE_FORMAT(actual_harvest_date, '%Y-%m-%d') AS actual_harvest_date
     FROM flock_cycles WHERE coop_id = ? AND status = 'active' ORDER BY id LIMIT 1 FOR UPDATE`,
    [coopId],
  );
  return row || null;
}

async function live(coopId, connection) {
  const [[row]] = await connection.query(
    `SELECT coop_id, device_id, flow_rate_lpm, water_total_liter, voltage_v, current_a,
       power_w, energy_kwh_total, frequency_hz, power_factor, source, recorded_at, phase_data_json
     FROM coop_live_status WHERE coop_id = ?`,
    [coopId],
  );
  return row || null;
}

async function devices(coopId, connection) {
  const [rows] = await connection.query(
    "SELECT id, name, is_active, connectivity_status, last_seen_at FROM devices WHERE coop_id = ? ORDER BY id",
    [coopId],
  );
  return rows;
}

async function alerts(coopId, source, connection, now = new Date()) {
  const [rows] = await connection.query(
    `SELECT id, alert_type, severity, status, title, message, source, detected_at, resolved_at, evidence_json
     FROM alerts WHERE coop_id = ? AND detected_at <= ? AND ((? = 'simulation' AND source = 'simulation')
       OR (? = 'real' AND source <> 'simulation'))
     ORDER BY (status = 'resolved'), detected_at DESC, id DESC LIMIT 20`,
    [coopId, now, source, source],
  );
  return rows;
}

module.exports = { coopLocation, farm, activeCycle, live, devices, alerts };
