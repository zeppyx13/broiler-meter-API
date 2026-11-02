const db = require("../config/db");

async function findAll({ room_id, type, is_active } = {}) {
  const where = [];
  const params = [];

  if (room_id !== undefined) {
    where.push("m.room_id = ?");
    params.push(room_id);
  }
  if (type !== undefined) {
    where.push("m.type = ?");
    params.push(type);
  }
  if (is_active !== undefined) {
    where.push("m.is_active = ?");
    params.push(Number(is_active));
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const [rows] = await db.query(
    `SELECT
       m.id, m.room_id, m.type, m.device_uid, m.unit,
       m.is_active, m.installed_at, m.created_at, m.updated_at,
       r.number AS room_number,
       r.floor  AS room_floor
     FROM meters m
     JOIN rooms r ON r.id = m.room_id
     ${whereSql}
     ORDER BY m.room_id ASC, m.type ASC`,
    params,
  );

  return rows;
}

async function findById(id) {
  const [rows] = await db.query(
    `SELECT
       m.id, m.room_id, m.type, m.device_uid, m.unit,
       m.is_active, m.installed_at, m.created_at, m.updated_at,
       r.number AS room_number,
       r.floor  AS room_floor
     FROM meters m
     JOIN rooms r ON r.id = m.room_id
     WHERE m.id = ?
     LIMIT 1`,
    [id],
  );
  return rows[0] || null;
}

async function findByDeviceUid(device_uid) {
  const [rows] = await db.query(
    `SELECT id FROM meters WHERE device_uid = ? LIMIT 1`,
    [device_uid],
  );
  return rows[0] || null;
}

async function findByRoomAndType(room_id, type) {
  const [rows] = await db.query(
    `SELECT id FROM meters WHERE room_id = ? AND type = ? LIMIT 1`,
    [room_id, type],
  );
  return rows[0] || null;
}

async function create({
  room_id,
  type,
  device_uid,
  unit,
  is_active = true,
  installed_at,
}) {
  const [result] = await db.query(
    `INSERT INTO meters (room_id, type, device_uid, unit, is_active, installed_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [room_id, type, device_uid, unit, is_active ? 1 : 0, installed_at || null],
  );
  return result.insertId;
}

async function updateById(id, data) {
  const allowed = ["device_uid", "unit", "is_active", "installed_at"];
  const fields = [];
  const params = [];

  for (const key of allowed) {
    if (data[key] === undefined) continue;
    fields.push(`${key} = ?`);
    params.push(key === "is_active" ? (data[key] ? 1 : 0) : data[key]);
  }

  if (!fields.length) return;

  params.push(id);
  await db.query(`UPDATE meters SET ${fields.join(", ")} WHERE id = ?`, params);
}

async function deleteById(id) {
  await db.query(`DELETE FROM meters WHERE id = ?`, [id]);
}

module.exports = {
  findAll,
  findById,
  findByDeviceUid,
  findByRoomAndType,
  create,
  updateById,
  deleteById,
};
