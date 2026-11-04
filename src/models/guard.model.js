const db = require("../config/db");

async function coopLocation(id) {
  const [[row]] = await db.query("SELECT farm_id FROM coops WHERE id = ?", [
    id,
  ]);
  return row || null;
}
async function ruleLocation(id) {
  const [[row]] = await db.query(
    "SELECT coop_id FROM alert_rules WHERE id = ?",
    [id],
  );
  return row || null;
}
async function alertLocation(id) {
  const [[row]] = await db.query("SELECT coop_id FROM alerts WHERE id = ?", [
    id,
  ]);
  return row || null;
}
async function coopContext(coopId, connection) {
  const [[row]] = await connection.query(
    `SELECT c.*,f.timezone,f.name AS farm_name,f.is_active AS farm_is_active
     FROM coops c JOIN farms f ON f.id=c.farm_id WHERE c.id=?`,
    [coopId],
  );
  return row || null;
}
async function rules(coopId, connection = db) {
  const [rows] = await connection.query(
    "SELECT * FROM alert_rules WHERE coop_id = ? ORDER BY id",
    [coopId],
  );
  return rows;
}
async function rule(id, connection = db) {
  const [[row]] = await connection.query(
    "SELECT * FROM alert_rules WHERE id = ?",
    [id],
  );
  return row || null;
}
async function createRule(data, connection) {
  const [result] = await connection.query(
    `INSERT INTO alert_rules (coop_id,rule_code,name,severity,parameters_json,evaluation_window_sec,cooldown_sec,is_active)
     VALUES (?,?,?,?,?,?,?,?)`,
    [
      data.coop_id,
      data.rule_code,
      data.name,
      data.severity,
      JSON.stringify(data.parameters_json),
      data.evaluation_window_sec,
      data.cooldown_sec,
      data.is_active,
    ],
  );
  return result.insertId;
}
async function updateRule(id, data, connection) {
  await connection.query(
    `UPDATE alert_rules SET name=?,severity=?,parameters_json=?,evaluation_window_sec=?,cooldown_sec=?,is_active=? WHERE id=?`,
    [
      data.name,
      data.severity,
      JSON.stringify(data.parameters_json),
      data.evaluation_window_sec,
      data.cooldown_sec,
      data.is_active,
      id,
    ],
  );
}
async function devices(coopId, connection) {
  const [rows] = await connection.query(
    "SELECT id,coop_id,mqtt_topic_key,is_active,last_seen_at FROM devices WHERE coop_id = ? ORDER BY id",
    [coopId],
  );
  return rows;
}
async function snapshot(coopId, connection) {
  const [[row]] = await connection.query(
    "SELECT * FROM coop_live_status WHERE coop_id = ?",
    [coopId],
  );
  return row || null;
}
async function activeCycle(coopId, connection) {
  const [[row]] = await connection.query(
    "SELECT id FROM flock_cycles WHERE coop_id = ? AND status = 'active' ORDER BY id LIMIT 1",
    [coopId],
  );
  return row?.id || null;
}
async function latestEpisode(key, connection) {
  const [[row]] = await connection.query(
    "SELECT * FROM alerts WHERE dedupe_key = ? ORDER BY id DESC LIMIT 1",
    [key],
  );
  return row || null;
}
async function createAlert(data, connection) {
  const [result] = await connection.query(
    `INSERT INTO alerts (coop_id,flock_cycle_id,device_id,alert_rule_id,alert_type,severity,title,message,evidence_json,dedupe_key,source,detected_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      data.coop_id,
      data.flock_cycle_id,
      data.device_id,
      data.alert_rule_id,
      data.alert_type,
      data.severity,
      data.title,
      data.message,
      JSON.stringify(data.evidence_json),
      data.dedupe_key,
      data.source,
      data.detected_at,
    ],
  );
  return result.insertId;
}
async function alert(id, connection = db) {
  const [[row]] = await connection.query("SELECT * FROM alerts WHERE id = ?", [
    id,
  ]);
  return row || null;
}
async function updateEvidence(id, evidence, connection) {
  await connection.query("UPDATE alerts SET evidence_json = ? WHERE id = ?", [
    JSON.stringify(evidence),
    id,
  ]);
}
async function acknowledge(id, userId, now, connection) {
  await connection.query(
    "UPDATE alerts SET status='acknowledged',acknowledged_by=?,acknowledged_at=? WHERE id=? AND status='active'",
    [userId, now, id],
  );
}
async function resolve(id, evidence, now, connection) {
  await connection.query(
    "UPDATE alerts SET status='resolved',resolved_at=?,evidence_json=? WHERE id=? AND status IN ('active','acknowledged')",
    [now, JSON.stringify(evidence), id],
  );
}
async function alerts(coopId, query, connection = db) {
  const [rows] = await connection.query(
    `SELECT * FROM alerts WHERE coop_id=? AND (? IS NULL OR status=?) AND (? IS NULL OR severity=?)
     AND (?='all' OR (?='simulation' AND source='simulation') OR (?='real' AND source<>'simulation'))
     AND (? IS NULL OR detected_at>=?) AND (? IS NULL OR detected_at<=?)
     ORDER BY detected_at DESC,id DESC LIMIT ? OFFSET ?`,
    [
      coopId,
      query.status || null,
      query.status || null,
      query.severity || null,
      query.severity || null,
      query.source,
      query.source,
      query.source,
      query.from ? new Date(query.from) : null,
      query.from ? new Date(query.from) : null,
      query.to ? new Date(query.to) : null,
      query.to ? new Date(query.to) : null,
      query.limit,
      (query.page - 1) * query.limit,
    ],
  );
  return rows;
}
async function watchdogCoops(afterId = 0) {
  const [rows] = await db.query(
    `SELECT DISTINCT c.id FROM coops c JOIN farms f ON f.id=c.farm_id
     JOIN alert_rules r ON r.coop_id=c.id WHERE c.id>? AND c.status='active' AND f.is_active=1 AND r.is_active=1
     ORDER BY c.id LIMIT 100`,
    [afterId],
  );
  return rows;
}

module.exports = {
  coopLocation,
  ruleLocation,
  alertLocation,
  coopContext,
  rules,
  rule,
  createRule,
  updateRule,
  devices,
  snapshot,
  activeCycle,
  latestEpisode,
  createAlert,
  alert,
  updateEvidence,
  acknowledge,
  resolve,
  alerts,
  watchdogCoops,
};
