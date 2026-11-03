const db = require("../config/db");

async function meterByUid(uid, connection = db) {
  const [rows] = await connection.query(
    `SELECT m.*, d.coop_id, d.is_active AS device_active, c.farm_id,
       c.status AS coop_status, f.is_active AS farm_active, f.timezone
     FROM meters m JOIN devices d ON d.id = m.device_id JOIN coops c ON c.id = d.coop_id
     JOIN farms f ON f.id = c.farm_id WHERE m.meter_uid = ?`,
    [uid],
  );
  return rows[0] || null;
}

async function deviceByTopic(key, connection = db) {
  const [rows] = await connection.query(
    `SELECT d.*, c.farm_id, c.status AS coop_status, f.is_active AS farm_active, f.timezone
     FROM devices d JOIN coops c ON c.id = d.coop_id JOIN farms f ON f.id = c.farm_id
     WHERE d.mqtt_topic_key = ?`,
    [key],
  );
  return rows[0] || null;
}

async function lockDevice(id, connection) {
  const [rows] = await connection.query(
    "SELECT * FROM devices WHERE id = ? FOR UPDATE",
    [id],
  );
  return rows[0] || null;
}

async function lockMeter(id, connection) {
  const [rows] = await connection.query(
    "SELECT * FROM meters WHERE id = ? FOR UPDATE",
    [id],
  );
  return rows[0] || null;
}

async function farmContext(id, connection) {
  const [[row]] = await connection.query(
    "SELECT is_active, timezone FROM farms WHERE id = ? LOCK IN SHARE MODE",
    [id],
  );
  return row;
}

async function duplicate(meterId, value, date, source, connection) {
  const [rows] = await connection.query(
    `SELECT id FROM meter_readings WHERE meter_id = ? AND recorded_at = ? AND reading_value = ?
     AND ((? = 'simulation' AND source = 'simulation') OR (? <> 'simulation' AND source <> 'simulation')) LIMIT 1 FOR UPDATE`,
    [meterId, date, value, source, source],
  );
  return rows[0] || null;
}

async function cursor(meterId, source, connection) {
  const [rows] = await connection.query(
    `SELECT reading_value, recorded_at, counter_epoch, flock_cycle_id FROM meter_readings
     WHERE meter_id = ? AND reading_status IN ('accepted','baseline','reset')
     AND ((? = 'simulation' AND source = 'simulation') OR (? <> 'simulation' AND source <> 'simulation'))
     ORDER BY recorded_at DESC, id DESC LIMIT 1 FOR UPDATE`,
    [meterId, source, source],
  );
  return rows[0] || null;
}

async function timestampConflict(meterId, date, source, connection) {
  const [rows] = await connection.query(
    `SELECT id FROM meter_readings WHERE meter_id = ? AND recorded_at = ?
     AND ((? = 'simulation' AND source = 'simulation') OR (? <> 'simulation' AND source <> 'simulation'))
     LIMIT 1 FOR UPDATE`,
    [meterId, date, source, source],
  );
  return rows.length > 0;
}

async function cycles(coopId, connection) {
  const [rows] = await connection.query(
    `SELECT id, status, created_at, DATE_FORMAT(placement_date, '%Y-%m-%d') AS placement_date,
       DATE_FORMAT(actual_harvest_date, '%Y-%m-%d') AS actual_harvest_date
     FROM flock_cycles WHERE coop_id = ? AND status IN ('active','completed') ORDER BY placement_date, id FOR UPDATE`,
    [coopId],
  );
  return rows;
}

async function insertReading(data, connection) {
  const [result] = await connection.query(
    `INSERT INTO meter_readings (meter_id, coop_id, flock_cycle_id, reading_value, delta_value,
       counter_epoch, reading_status, source, recorded_at, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      data.meter_id,
      data.coop_id,
      data.flock_cycle_id,
      data.reading_value,
      data.delta_value,
      data.counter_epoch,
      data.reading_status,
      data.source,
      data.recorded_at,
      data.received_at,
    ],
  );
  return result.insertId;
}

async function updateCursor(data, connection) {
  await connection.query(
    "UPDATE meters SET last_reading_value = ?, last_reading_at = ?, counter_epoch = ? WHERE id = ?",
    [data.reading_value, data.recorded_at, data.counter_epoch, data.meter_id],
  );
}

async function seen(deviceId, receivedAt, connection) {
  await connection.query(
    `UPDATE devices SET last_seen_at = CASE WHEN last_seen_at IS NULL OR last_seen_at < ? THEN ? ELSE last_seen_at END,
      connectivity_status = 'online' WHERE id = ?`,
    [receivedAt, receivedAt, deviceId],
  );
  const [[row]] = await connection.query(
    "SELECT last_seen_at FROM devices WHERE id = ? LOCK IN SHARE MODE",
    [deviceId],
  );
  return row.last_seen_at;
}

async function snapshot(coopId, connection) {
  const [rows] = await connection.query(
    "SELECT * FROM coop_live_status WHERE coop_id = ? FOR UPDATE",
    [coopId],
  );
  return rows[0] || null;
}

async function saveSnapshot(data, connection) {
  await connection.query(
    `INSERT INTO coop_live_status (coop_id, device_id, flow_rate_lpm, water_total_liter, voltage_v,
       current_a, power_w, energy_kwh_total, frequency_hz, power_factor, phase_data_json, source, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE device_id=VALUES(device_id), flow_rate_lpm=VALUES(flow_rate_lpm),
       water_total_liter=VALUES(water_total_liter), voltage_v=VALUES(voltage_v), current_a=VALUES(current_a),
       power_w=VALUES(power_w), energy_kwh_total=VALUES(energy_kwh_total), frequency_hz=VALUES(frequency_hz),
       power_factor=VALUES(power_factor), phase_data_json=VALUES(phase_data_json), source=VALUES(source), recorded_at=VALUES(recorded_at)`,
    [
      data.coop_id,
      data.device_id,
      data.flow_rate_lpm,
      data.water_total_liter,
      data.voltage_v,
      data.current_a,
      data.power_w,
      data.energy_kwh_total,
      data.frequency_hz,
      data.power_factor,
      JSON.stringify(data.phase_data_json),
      data.source,
      data.recorded_at,
    ],
  );
}

async function staleDevices(cutoff) {
  const [rows] = await db.query(
    "SELECT id, coop_id, last_seen_at FROM devices WHERE is_active = 1 AND connectivity_status = 'online' AND last_seen_at < ?",
    [cutoff],
  );
  return rows;
}

async function markOffline(id, cutoff) {
  const [result] = await db.query(
    "UPDATE devices SET connectivity_status = 'offline' WHERE id = ? AND last_seen_at < ? AND connectivity_status = 'online'",
    [id, cutoff],
  );
  return result.affectedRows > 0;
}

module.exports = {
  meterByUid,
  deviceByTopic,
  lockDevice,
  lockMeter,
  farmContext,
  duplicate,
  cursor,
  timestampConflict,
  cycles,
  insertReading,
  updateCursor,
  seen,
  snapshot,
  saveSnapshot,
  staleDevices,
  markOffline,
};
