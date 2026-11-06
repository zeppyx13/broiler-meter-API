const db = require("../config/db");

async function insertSample(connection, sample) {
  const [result] = await connection.query(
    `INSERT IGNORE INTO telemetry_samples (coop_id,device_id,source,sample_bucket,recorded_at,received_at,fields_json,quality_json) VALUES (?,?,?,?,?,?,?,?)`,
    [sample.coop_id, sample.device_id, sample.source, sample.sample_bucket, sample.recorded_at, sample.received_at, JSON.stringify(sample.fields_json), JSON.stringify(sample.quality_json)],
  );
  return result.affectedRows > 0;
}
async function prune(connection, cutoff) {
  // Only bounded Phase5 buffers are retained. Original readings/cursors are never deleted.
  await connection.query("DELETE FROM telemetry_samples WHERE received_at < ? ORDER BY received_at LIMIT 1000", [cutoff]);
  await connection.query("DELETE FROM device_diagnostic_entries WHERE received_at < ? ORDER BY received_at LIMIT 1000", [cutoff]);
}
async function history(coopId, source, from, to) {
  const [rows] = await db.query(
    `SELECT device_id,recorded_at,received_at,fields_json,quality_json FROM telemetry_samples WHERE coop_id=? AND source=? AND recorded_at>=? AND recorded_at<=? ORDER BY recorded_at DESC,id DESC LIMIT 20000`,
    [coopId, source, from, to],
  );
  return rows;
}
async function diagnostic(connection, data) {
  await connection.query(
    `INSERT INTO device_diagnostic_entries (coop_id,device_id,level,code,message,source,recorded_at,received_at) VALUES (?,?,?,?,?,?,?,?)`,
    [data.coop_id, data.device_id, data.level, data.code, data.message, data.source, data.recorded_at, data.received_at],
  );
}
async function diagnostics(coopId, query) {
  const [rows] = await db.query(
    `SELECT id,device_id,level,code,message,source,recorded_at,received_at FROM device_diagnostic_entries WHERE coop_id=? AND source=? AND (? IS NULL OR id<?) ORDER BY id DESC LIMIT ?`,
    [coopId, query.source, query.before_id || null, query.before_id || null, query.limit],
  );
  return rows;
}
async function device(id, connection = db) {
  const [[row]] = await connection.query("SELECT id,coop_id,is_active,last_seen_at FROM devices WHERE id=?", [id]);
  return row || null;
}
async function calibrations(coopId, query) {
  const [rows] = await db.query(
    `SELECT * FROM sensor_calibrations WHERE coop_id=? AND source=? AND (? IS NULL OR id<?) ORDER BY id DESC LIMIT ?`,
    [coopId, query.source, query.before_id || null, query.before_id || null, query.limit],
  );
  return rows;
}
async function createCalibration(connection, coopId, userId, data) {
  const [result] = await connection.query(
    `INSERT INTO sensor_calibrations (coop_id,device_id,type,reference_value,sensor_value,unit,instrument_id,method,measured_at,source,note,recorded_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [coopId, data.device_id || null, data.type, data.reference_value, data.sensor_value, data.unit, data.instrument_id, data.method, new Date(data.measured_at), data.source, data.note || null, userId],
  );
  return result.insertId;
}
async function entry(connection, table, coopId, id, lock = false) {
  if (!["sensor_calibrations", "field_validation_events"].includes(table)) throw new Error("Unsupported evidence table");
  const [[row]] = await connection.query(`SELECT * FROM ${table} WHERE coop_id=? AND id=?${lock ? " FOR UPDATE" : ""}`, [coopId, id]);
  return row || null;
}
async function verify(connection, table, id, userId, evidenceNote, now) {
  if (!["sensor_calibrations", "field_validation_events"].includes(table)) throw new Error("Unsupported evidence table");
  await connection.query(`UPDATE ${table} SET verification_state='independently_verified',verified_by=?,verified_at=?,evidence_note=? WHERE id=?`, [userId, now, evidenceNote, id]);
}
async function createEvidence(connection, coopId, userId, data) {
  const [result] = await connection.query(
    `INSERT INTO field_validation_events (coop_id,kind,source,instrument_id,method,observed_start,observed_end,evidence_json,recorded_by) VALUES (?,?,?,?,?,?,?,?,?)`,
    [coopId, data.kind, data.source, data.instrument_id, data.method, new Date(data.observed_start), new Date(data.observed_end), JSON.stringify(data.evidence), userId],
  );
  return result.insertId;
}
async function evidence(coopId, query) {
  const [rows] = await db.query(`SELECT * FROM field_validation_events WHERE coop_id=? AND source=? AND (? IS NULL OR id<?) ORDER BY id DESC LIMIT ?`, [coopId, query.source, query.before_id || null, query.before_id || null, query.limit]);
  return rows;
}
async function alert(coopId, id, connection) {
  const [[row]] = await connection.query("SELECT id,detected_at,source FROM alerts WHERE coop_id=? AND id=?", [coopId, id]);
  return row || null;
}
async function maintenance(connection, coopId, userId, input) {
  const [[previous]] = await connection.query("SELECT * FROM maintenance_requests WHERE requested_by=? AND request_id=? FOR UPDATE", [userId, input.request_id]);
  if (previous) return previous;
  const [created] = await connection.query("INSERT INTO maintenance_requests (coop_id,device_id,requested_by,request_id,command,reason) VALUES (?,?,?,?,?,?)", [coopId, input.device_id, userId, input.request_id, input.command, input.reason]);
  return { id: created.insertId, coop_id: coopId, device_id: input.device_id, command: input.command, reason: input.reason, status: "blocked_hardware_acceptance" };
}

module.exports = { insertSample, prune, history, diagnostic, diagnostics, device, calibrations, createCalibration, entry, verify, createEvidence, evidence, alert, maintenance };
