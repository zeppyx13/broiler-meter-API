const db = require("../config/db");

async function list(
  user,
  { device_id = null, coop_id = null, page, limit },
  connection = db,
) {
  const [rows] = await connection.query(
    `SELECT r.*, d.coop_id FROM relays r JOIN devices d ON d.id = r.device_id JOIN coops c ON c.id = d.coop_id
     LEFT JOIN farm_members m ON m.farm_id = c.farm_id AND m.user_id = ?
     WHERE (? = 'admin' OR m.user_id IS NOT NULL) AND (? IS NULL OR r.device_id = ?)
       AND (? IS NULL OR d.coop_id = ?) ORDER BY r.id LIMIT ? OFFSET ?`,
    [
      user.id,
      user.role,
      device_id,
      device_id,
      coop_id,
      coop_id,
      limit,
      (page - 1) * limit,
    ],
  );
  return rows;
}

async function findById(id, connection = db) {
  const [rows] = await connection.query(
    `SELECT r.*, d.coop_id, c.farm_id FROM relays r JOIN devices d ON d.id = r.device_id
     JOIN coops c ON c.id = d.coop_id WHERE r.id = ?`,
    [id],
  );
  return rows[0] || null;
}

async function lockById(id, connection) {
  const [rows] = await connection.query(
    "SELECT * FROM relays WHERE id = ? FOR UPDATE",
    [id],
  );
  return rows[0] || null;
}

async function forDevice(deviceId, connection) {
  const [rows] = await connection.query(
    "SELECT * FROM relays WHERE device_id = ? AND channel = 1 FOR UPDATE",
    [deviceId],
  );
  return rows[0] || null;
}

async function create(data, connection) {
  const [result] = await connection.query(
    "INSERT INTO relays (device_id, channel, name, purpose, is_enabled) VALUES (?, ?, ?, ?, ?)",
    [
      data.device_id,
      data.channel,
      data.name,
      data.purpose,
      data.is_enabled ? 1 : 0,
    ],
  );
  return result.insertId;
}

async function update(id, data, connection) {
  await connection.query(
    "UPDATE relays SET name = ?, purpose = ?, is_enabled = ? WHERE id = ?",
    [data.name, data.purpose, data.is_enabled ? 1 : 0, id],
  );
}

async function farmIsActive(id, connection) {
  const [[row]] = await connection.query(
    "SELECT is_active FROM farms WHERE id = ? LOCK IN SHARE MODE",
    [id],
  );
  return Boolean(row?.is_active);
}

async function latestCommand(relayId, connection) {
  // Caller holds farm/coop/device/relay locks before its first consistent read.
  // A locking empty range could take a shared supremum gap across unrelated relays.
  const [rows] = await connection.query(
    "SELECT * FROM relay_commands WHERE relay_id = ? ORDER BY id DESC LIMIT 1",
    [relayId],
  );
  return rows[0] || null;
}

async function commandById(id, connection = db) {
  const [rows] = await connection.query(
    "SELECT * FROM relay_commands WHERE id = ? LOCK IN SHARE MODE",
    [id],
  );
  return rows[0] || null;
}

async function lockCommand(id, connection) {
  const [rows] = await connection.query(
    "SELECT * FROM relay_commands WHERE id = ? FOR UPDATE",
    [id],
  );
  return rows[0] || null;
}

async function commands(relayId, { page, limit }, connection = db) {
  const [rows] = await connection.query(
    "SELECT * FROM relay_commands WHERE relay_id = ? ORDER BY id DESC LIMIT ? OFFSET ?",
    [relayId, limit, (page - 1) * limit],
  );
  return rows;
}

async function insertCommand(data, connection) {
  const [result] = await connection.query(
    `INSERT INTO relay_commands (relay_id, requested_by, correlation_id, command, status, source, requested_at)
     VALUES (?, ?, ?, ?, 'queued', 'manual', ?)`,
    [
      data.relay_id,
      data.requested_by,
      data.correlation_id,
      data.command,
      data.requested_at,
    ],
  );
  await connection.query("UPDATE relays SET desired_state = ? WHERE id = ?", [
    data.command,
    data.relay_id,
  ]);
  return result.insertId;
}

async function transition(id, status, date, reason, connection) {
  const [result] = await connection.query(
    `UPDATE relay_commands SET status = ?, published_at = CASE WHEN ? = 'published' THEN ? ELSE published_at END,
      failure_reason = ? WHERE id = ? AND status = 'queued'`,
    [status, status, date, reason, id],
  );
  return result.affectedRows > 0;
}

async function pendingBefore(cutoff) {
  const [rows] = await db.query(
    `SELECT rc.id, rc.relay_id, r.device_id, d.coop_id FROM relay_commands rc
     JOIN relays r ON r.id = rc.relay_id JOIN devices d ON d.id = r.device_id
     WHERE rc.source = 'manual' AND rc.status IN ('queued','published') AND rc.requested_at <= ?
     ORDER BY rc.id LIMIT 100`,
    [cutoff],
  );
  return rows;
}

async function expire(id, cutoff, connection) {
  const [result] = await connection.query(
    `UPDATE relay_commands SET status = 'timed_out', failure_reason = ?
     WHERE id = ? AND status IN ('queued','published') AND requested_at <= ?`,
    [
      "No correlated device confirmation is available in firmware v3.1; physical outcome is unknown",
      id,
      cutoff,
    ],
  );
  return result.affectedRows > 0;
}

async function reportState(id, state, date, connection) {
  await connection.query(
    "UPDATE relays SET reported_state = ?, last_reported_at = ? WHERE id = ?",
    [state, date, id],
  );
}

module.exports = {
  list,
  findById,
  lockById,
  forDevice,
  create,
  update,
  farmIsActive,
  latestCommand,
  commandById,
  lockCommand,
  commands,
  insertCommand,
  transition,
  pendingBefore,
  expire,
  reportState,
};
