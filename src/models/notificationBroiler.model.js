const db = require("../config/db");

async function lockAlert(id, connection) {
  const [rows] = await connection.query(
    "SELECT * FROM alerts WHERE id = ? FOR UPDATE",
    [id],
  );
  return rows[0] || null;
}

async function recipients(farmId, connection) {
  const [rows] = await connection.query(
    `SELECT u.id, u.email FROM farm_members m JOIN users u ON u.id = m.user_id
     WHERE m.farm_id = ? AND m.role IN ('owner','manager','operator')
     ORDER BY u.id LOCK IN SHARE MODE`,
    [farmId],
  );
  return rows;
}

async function existing(alertId, userId, channel, connection) {
  const [rows] = await connection.query(
    "SELECT id FROM notifications WHERE alert_id = ? AND user_id = ? AND channel = ? LIMIT 1",
    [alertId, userId, channel],
  );
  return rows[0] || null;
}

async function create(data, connection) {
  const [result] = await connection.query(
    `INSERT INTO notifications (user_id, alert_id, channel, title, body, delivery_status, error_message, sent_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      data.user_id,
      data.alert_id,
      data.channel,
      data.title,
      data.body,
      data.delivery_status,
      data.error_message || null,
      data.sent_at || null,
    ],
  );
  return result.insertId;
}

async function findById(id, connection = db) {
  const [rows] = await connection.query(
    `SELECT n.*, a.coop_id, a.source, a.severity FROM notifications n
     JOIN alerts a ON a.id = n.alert_id WHERE n.id = ?`,
    [id],
  );
  return rows[0] || null;
}

async function list(
  user,
  { page, limit, coop_id = null, channel, unread = null },
) {
  const [rows] = await db.query(
    `SELECT n.*, a.coop_id, a.source, a.severity FROM notifications n
     JOIN alerts a ON a.id = n.alert_id JOIN coops c ON c.id = a.coop_id
     LEFT JOIN farm_members m ON m.farm_id = c.farm_id AND m.user_id = n.user_id
     WHERE n.user_id = ? AND n.channel = ? AND m.role IN ('owner','manager','operator')
       AND (? IS NULL OR a.coop_id = ?) AND (? IS NULL OR (n.read_at IS NULL) = ?)
     ORDER BY n.id DESC LIMIT ? OFFSET ?`,
    [
      user.id,
      channel,
      coop_id,
      coop_id,
      unread,
      unread,
      limit,
      (page - 1) * limit,
    ],
  );
  const [[count]] = await db.query(
    `SELECT COUNT(*) AS total FROM notifications n JOIN alerts a ON a.id = n.alert_id
     JOIN coops c ON c.id = a.coop_id
     LEFT JOIN farm_members m ON m.farm_id = c.farm_id AND m.user_id = n.user_id
     WHERE n.user_id = ? AND n.channel = ? AND m.role IN ('owner','manager','operator')
       AND (? IS NULL OR a.coop_id = ?) AND (? IS NULL OR (n.read_at IS NULL) = ?)`,
    [user.id, channel, coop_id, coop_id, unread, unread],
  );
  return { rows, total: Number(count.total) };
}

async function unreadCount(user, coopId = null) {
  const [[row]] = await db.query(
    `SELECT COUNT(*) AS count FROM notifications n JOIN alerts a ON a.id = n.alert_id
     JOIN coops c ON c.id = a.coop_id
     LEFT JOIN farm_members m ON m.farm_id = c.farm_id AND m.user_id = n.user_id
     WHERE n.user_id = ? AND n.channel = 'in_app' AND n.read_at IS NULL
       AND m.role IN ('owner','manager','operator') AND (? IS NULL OR a.coop_id = ?)`,
    [user.id, coopId, coopId],
  );
  return Number(row.count);
}

async function markRead(id, userId, connection) {
  await connection.query(
    "UPDATE notifications SET read_at = COALESCE(read_at, UTC_TIMESTAMP()) WHERE id = ? AND user_id = ? AND channel = 'in_app'",
    [id, userId],
  );
}

async function unreadCoops(user) {
  const [rows] = await db.query(
    `SELECT DISTINCT a.coop_id, c.farm_id FROM notifications n
     JOIN alerts a ON a.id = n.alert_id JOIN coops c ON c.id = a.coop_id
     LEFT JOIN farm_members m ON m.farm_id = c.farm_id AND m.user_id = n.user_id
     WHERE n.user_id = ? AND n.channel = 'in_app' AND n.read_at IS NULL
       AND m.role IN ('owner','manager','operator') ORDER BY c.farm_id, a.coop_id`,
    [user.id],
  );
  return rows;
}

async function markCoopRead(coopId, userId, connection) {
  const [result] = await connection.query(
    `UPDATE notifications n JOIN alerts a ON a.id = n.alert_id
     SET n.read_at = UTC_TIMESTAMP() WHERE a.coop_id = ? AND n.user_id = ?
       AND n.channel = 'in_app' AND n.read_at IS NULL`,
    [coopId, userId],
  );
  return result.affectedRows;
}

module.exports = {
  lockAlert,
  recipients,
  existing,
  create,
  findById,
  list,
  unreadCount,
  markRead,
  unreadCoops,
  markCoopRead,
};
