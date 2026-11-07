const db = require("../config/db");

const requestSelect = `SELECT r.id,r.coop_id,r.device_id,r.requested_by,r.request_id,r.command,r.reason,r.requested_at,
  d.payload_hash,d.target_fingerprint,d.status,d.http_status,d.preflight_json,d.accepted_at,d.publish_attempted_at,
  d.published_at,d.timeout_at,d.completed_at,d.failure_reason,d.observation_json
  FROM maintenance_requests r JOIN maintenance_request_details d ON d.maintenance_request_id=r.id`;
// access.lockCoop does an initial routing read before waiting for parent locks.
// Transaction decisions must use current reads rather than that earlier repeatable-read snapshot.
const currentRead = (connection) => (connection === db ? "" : " FOR UPDATE");
async function actor(id, connection) {
  const [[row]] = await connection.query(
    "SELECT id,role FROM users WHERE id=? LOCK IN SHARE MODE",
    [id],
  );
  return row || null;
}

async function devices(coopId, connection = db) {
  const [rows] = await connection.query(
    "SELECT * FROM devices WHERE coop_id=? ORDER BY id LIMIT 101",
    [coopId],
  );
  return rows;
}
async function acceptance(deviceId, command, connection = db) {
  const [[row]] = await connection.query(
    `SELECT * FROM maintenance_acceptance_events WHERE device_id=? AND command=? ORDER BY id DESC LIMIT 1${currentRead(connection)}`,
    [deviceId, command],
  );
  return row || null;
}
async function acceptanceReplay(actor, requestId, connection) {
  const [[row]] = await connection.query(
    "SELECT * FROM maintenance_acceptance_events WHERE actor_id=? AND request_id=? FOR UPDATE",
    [actor, requestId],
  );
  return row || null;
}
async function insertAcceptance(data, connection) {
  const [result] = await connection.query(
    "INSERT INTO maintenance_acceptance_events (coop_id,device_id,command,accepted,target_fingerprint,actor_id,request_id,payload_hash,evidence_reference,note,recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    [
      data.coop_id,
      data.device_id,
      data.command,
      data.accepted ? 1 : 0,
      data.target_fingerprint,
      data.actor_id,
      data.request_id,
      data.payload_hash,
      data.evidence_reference,
      data.note,
      data.recorded_at,
    ],
  );
  return result.insertId;
}
async function byUuid(actor, requestId, connection = db) {
  const [[row]] = await connection.query(
    `${requestSelect} WHERE r.requested_by=? AND r.request_id=?${currentRead(connection)}`,
    [actor, requestId],
  );
  return row || null;
}
async function legacyUuid(actor, requestId, connection) {
  const [[row]] = await connection.query(
    "SELECT id FROM maintenance_requests WHERE requested_by=? AND request_id=? FOR UPDATE",
    [actor, requestId],
  );
  return row || null;
}
async function byId(id, connection = db) {
  const [[row]] = await connection.query(
    `${requestSelect} WHERE r.id=?${currentRead(connection)}`,
    [id],
  );
  return row || null;
}
async function recent(coopId, connection = db) {
  const [rows] = await connection.query(
    `${requestSelect} WHERE r.coop_id=? ORDER BY r.id DESC LIMIT 25${currentRead(connection)}`,
    [coopId],
  );
  return rows;
}
async function latest(deviceId, connection = db) {
  const [[row]] = await connection.query(
    `${requestSelect} WHERE r.device_id=? AND d.status<>'blocked' ORDER BY r.id DESC LIMIT 1${currentRead(connection)}`,
    [deviceId],
  );
  return row || null;
}
async function pending(deviceId, connection = db) {
  const [[row]] = await connection.query(
    `${requestSelect} WHERE r.device_id=? AND d.status IN ('accepted','publishing','published','observed') AND d.timeout_at>? ORDER BY r.id DESC LIMIT 1${currentRead(connection)}`,
    [deviceId, new Date()],
  );
  return row || null;
}
async function relayPending(deviceId, connection = db) {
  const [[row]] = await connection.query(
    `SELECT rc.id,rc.requested_at FROM relay_commands rc JOIN relays r ON r.id=rc.relay_id WHERE r.device_id=? AND rc.status IN ('queued','published') ORDER BY rc.id DESC LIMIT 1${currentRead(connection)}`,
    [deviceId],
  );
  return row || null;
}
async function insertRequest(data, connection) {
  const [result] = await connection.query(
    "INSERT INTO maintenance_requests (coop_id,device_id,requested_by,request_id,command,reason) VALUES (?,?,?,?,?,?)",
    [
      data.coop_id,
      data.device_id,
      data.requested_by,
      data.request_id,
      data.command,
      data.reason,
    ],
  );
  await connection.query(
    "INSERT INTO maintenance_request_details (maintenance_request_id,payload_hash,target_fingerprint,status,http_status,preflight_json,accepted_at,timeout_at,completed_at,failure_reason) VALUES (?,?,?,?,?,?,?,?,?,?)",
    [
      result.insertId,
      data.payload_hash,
      data.target_fingerprint,
      data.status,
      data.http_status,
      JSON.stringify(data.preflight),
      data.accepted_at,
      data.timeout_at,
      data.status === "blocked" ? data.accepted_at : null,
      data.failure_reason,
    ],
  );
  return result.insertId;
}
async function publishAttempt(id, now, connection) {
  await connection.query(
    "UPDATE maintenance_request_details SET status='publishing',publish_attempted_at=? WHERE maintenance_request_id=? AND status='accepted'",
    [now, id],
  );
}
async function finish(id, status, httpStatus, reason, now, connection) {
  await connection.query(
    `UPDATE maintenance_request_details SET status=?,http_status=?,failure_reason=?,
     published_at=CASE WHEN ?='published' THEN ? ELSE published_at END,
     completed_at=CASE WHEN ? IN ('failed','blocked','timed_out') THEN ? ELSE completed_at END
     WHERE maintenance_request_id=? AND status IN ('accepted','publishing')`,
    [status, httpStatus, reason, status, now, status, now, id],
  );
}
async function observe(id, observation, connection) {
  await connection.query(
    "UPDATE maintenance_request_details SET status='observed',observation_json=? WHERE maintenance_request_id=? AND status IN ('publishing','published','observed')",
    [JSON.stringify(observation), id],
  );
}
async function expireDevice(deviceId, now, connection) {
  await connection.query(
    `UPDATE maintenance_request_details d JOIN maintenance_requests r ON r.id=d.maintenance_request_id
     SET d.status=CASE WHEN d.observation_json IS NULL THEN 'timed_out' ELSE 'unverified' END,
         d.completed_at=?,d.failure_reason='No correlated firmware acknowledgement; physical outcome remains unknown',d.http_status=202
     WHERE r.device_id=? AND d.status IN ('accepted','publishing','published','observed') AND d.timeout_at<=?`,
    [now, deviceId, now],
  );
}
async function expired(now) {
  const [rows] = await db.query(
    `${requestSelect} WHERE d.status IN ('accepted','publishing','published','observed') AND d.timeout_at<=? ORDER BY r.id LIMIT 100`,
    [now],
  );
  return rows;
}

module.exports = {
  actor,
  devices,
  acceptance,
  acceptanceReplay,
  insertAcceptance,
  byUuid,
  legacyUuid,
  byId,
  recent,
  latest,
  pending,
  relayPending,
  insertRequest,
  publishAttempt,
  finish,
  observe,
  expireDevice,
  expired,
};
