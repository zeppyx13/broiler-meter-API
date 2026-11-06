const db = require("../config/db");
const scope = require("../utils/coopScope");

async function list(
  user,
  { coop_id = null, is_active = null, page, limit },
  connection = db,
) {
  const scoped = await scope.predicate(connection);
  const [rows] = await connection.query(
    `SELECT d.*, c.name AS coop_name, f.timezone
     FROM devices d JOIN coops c ON c.id = d.coop_id JOIN farms f ON f.id = c.farm_id
     LEFT JOIN farm_members m ON m.farm_id = f.id AND m.user_id = ?
     WHERE (? = 'admin' OR (m.user_id IS NOT NULL AND ${scoped}))
       AND (? IS NULL OR d.coop_id = ?) AND (? IS NULL OR d.is_active = ?)
     ORDER BY d.id LIMIT ? OFFSET ?`,
    [
      user.id,
      user.role,
      coop_id,
      coop_id,
      is_active,
      is_active,
      limit,
      (page - 1) * limit,
    ],
  );
  return rows;
}

async function findById(id, connection = db) {
  const [rows] = await connection.query("SELECT * FROM devices WHERE id = ?", [
    id,
  ]);
  return rows[0] || null;
}

async function findByTopicKey(key, connection = db) {
  const [rows] = await connection.query(
    "SELECT * FROM devices WHERE mqtt_topic_key = ?",
    [key],
  );
  return rows[0] || null;
}

async function lockById(id, connection) {
  const [rows] = await connection.query(
    "SELECT * FROM devices WHERE id = ? FOR UPDATE",
    [id],
  );
  return rows[0] || null;
}

async function create(data, connection) {
  const [result] = await connection.query(
    `INSERT INTO devices (coop_id, device_uid, mqtt_topic_key, name, device_type, firmware_version, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      data.coop_id,
      data.device_uid,
      data.mqtt_topic_key,
      data.name,
      data.device_type,
      data.firmware_version,
      data.is_active ? 1 : 0,
    ],
  );
  return result.insertId;
}

async function update(id, data, connection) {
  await connection.query(
    "UPDATE devices SET name = ?, device_type = ?, firmware_version = ?, is_active = ? WHERE id = ?",
    [
      data.name,
      data.device_type,
      data.firmware_version,
      data.is_active ? 1 : 0,
      id,
    ],
  );
}

module.exports = { list, findById, findByTopicKey, lockById, create, update };
