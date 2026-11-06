const db = require("../config/db");
const scope = require("../utils/coopScope");

async function list(
  user,
  {
    coop_id = null,
    device_id = null,
    type = null,
    is_active = null,
    page,
    limit,
  },
  connection = db,
) {
  const scoped = await scope.predicate(connection);
  const [rows] = await connection.query(
    `SELECT mt.*, d.coop_id, d.device_uid, d.is_active AS device_is_active, c.name AS coop_name
     FROM meters mt JOIN devices d ON d.id = mt.device_id
     JOIN coops c ON c.id = d.coop_id JOIN farms f ON f.id = c.farm_id
     LEFT JOIN farm_members m ON m.farm_id = f.id AND m.user_id = ?
     WHERE (? = 'admin' OR (m.user_id IS NOT NULL AND ${scoped}))
       AND (? IS NULL OR d.coop_id = ?) AND (? IS NULL OR mt.device_id = ?)
       AND (? IS NULL OR mt.type = ?) AND (? IS NULL OR mt.is_active = ?)
     ORDER BY mt.id LIMIT ? OFFSET ?`,
    [
      user.id,
      user.role,
      coop_id,
      coop_id,
      device_id,
      device_id,
      type,
      type,
      is_active,
      is_active,
      limit,
      (page - 1) * limit,
    ],
  );
  return rows;
}

async function findById(id, connection = db) {
  const [rows] = await connection.query("SELECT * FROM meters WHERE id = ?", [
    id,
  ]);
  return rows[0] || null;
}

async function findByUid(uid, connection = db) {
  const [rows] = await connection.query(
    "SELECT * FROM meters WHERE meter_uid = ?",
    [uid],
  );
  return rows[0] || null;
}

async function lockById(id, connection) {
  const [rows] = await connection.query(
    "SELECT * FROM meters WHERE id = ? FOR UPDATE",
    [id],
  );
  return rows[0] || null;
}

async function electricalChannels(deviceId, connection) {
  const [rows] = await connection.query(
    "SELECT id, channel FROM meters WHERE device_id = ? AND type = 'electricity' FOR UPDATE",
    [deviceId],
  );
  return rows;
}

async function create(data, connection) {
  const [result] = await connection.query(
    `INSERT INTO meters (device_id, meter_uid, type, channel, unit, is_active, installed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      data.device_id,
      data.meter_uid,
      data.type,
      data.channel,
      data.unit,
      data.is_active ? 1 : 0,
      data.installed_at ? new Date(data.installed_at) : null,
    ],
  );
  return result.insertId;
}

async function update(id, data, connection) {
  await connection.query(
    "UPDATE meters SET is_active = ?, installed_at = ? WHERE id = ?",
    [
      data.is_active ? 1 : 0,
      data.installed_at ? new Date(data.installed_at) : null,
      id,
    ],
  );
}

module.exports = {
  list,
  findById,
  findByUid,
  lockById,
  electricalChannels,
  create,
  update,
};
