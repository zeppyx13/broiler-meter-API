const db = require("../config/db");
const scope = require("../utils/coopScope");

async function candidates(limit) {
  const [rows] = await db.query(
    `SELECT n.id, a.coop_id FROM notifications n JOIN alerts a ON a.id = n.alert_id
     WHERE n.channel = 'email' AND n.delivery_status = 'pending' ORDER BY n.id LIMIT ?`,
    [limit],
  );
  return rows;
}

async function lockContext(id, connection) {
  const scoped = await scope.predicate(connection);
  const [rows] = await connection.query(
    `SELECT n.*, a.coop_id, a.source, a.severity, a.alert_type, a.detected_at, a.status AS alert_status,
       c.name AS coop_name, c.farm_id, f.timezone, u.email, CASE WHEN ${scoped} THEN m.role ELSE NULL END AS recipient_role
     FROM notifications n JOIN alerts a ON a.id = n.alert_id JOIN coops c ON c.id = a.coop_id
     JOIN farms f ON f.id = c.farm_id JOIN users u ON u.id = n.user_id
     LEFT JOIN farm_members m ON m.farm_id = c.farm_id AND m.user_id = n.user_id
     WHERE n.id = ? AND n.channel = 'email' FOR UPDATE`,
    [id],
  );
  return rows[0] || null;
}

async function setState(id, status, audit, sentAt, connection = db) {
  await connection.query(
    "UPDATE notifications SET delivery_status = ?, error_message = ?, sent_at = ? WHERE id = ? AND channel = 'email'",
    [status, JSON.stringify(audit), sentAt, id],
  );
}

async function finishClaim(
  id,
  expected,
  status,
  audit,
  sentAt,
  connection = db,
) {
  const [result] = await connection.query(
    `UPDATE notifications SET delivery_status = ?, error_message = ?, sent_at = ?
     WHERE id = ? AND channel = 'email' AND delivery_status = 'pending' AND error_message = ?`,
    [status, JSON.stringify(audit), sentAt, id, expected],
  );
  return result.affectedRows === 1;
}

module.exports = { candidates, lockContext, setState, finishClaim };
