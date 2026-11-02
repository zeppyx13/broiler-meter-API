const db = require("../config/db");

async function findAll({ status, user_id, room_id, page = 1, limit = 10 }) {
  const p = Math.max(1, Number(page));
  const l = Math.min(100, Math.max(1, Number(limit)));
  const offset = (p - 1) * l;

  const where = [];
  const params = [];

  if (status) {
    where.push("l.status = ?");
    params.push(status);
  }
  if (user_id) {
    where.push("l.user_id = ?");
    params.push(user_id);
  }
  if (room_id) {
    where.push("l.room_id = ?");
    params.push(room_id);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const [rows] = await db.query(
    `SELECT
       l.id, l.user_id, l.room_id, l.start_date, l.end_date,
       l.status, l.monthly_rent_snapshot, l.note,
       l.created_at, l.updated_at,
       u.name  AS tenant_name,
       u.email AS tenant_email,
       r.number AS room_number,
       r.floor  AS room_floor
     FROM leases l
     JOIN users u ON u.id = l.user_id
     JOIN rooms r ON r.id = l.room_id
     ${whereSql}
     ORDER BY l.created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, l, offset],
  );

  const [[{ total }]] = await db.query(
    `SELECT COUNT(*) AS total FROM leases l ${whereSql}`,
    params,
  );

  return { rows, total: Number(total), page: p, limit: l };
}

async function findById(id) {
  const [rows] = await db.query(
    `SELECT
       l.id, l.user_id, l.room_id, l.start_date, l.end_date,
       l.status, l.monthly_rent_snapshot, l.note,
       l.created_at, l.updated_at,
       u.name  AS tenant_name,
       u.email AS tenant_email,
       r.number AS room_number,
       r.floor  AS room_floor
     FROM leases l
     JOIN users u ON u.id = l.user_id
     JOIN rooms r ON r.id = l.room_id
     WHERE l.id = ?
     LIMIT 1`,
    [id],
  );
  return rows[0] || null;
}

async function findActiveByRoomId(room_id) {
  const [rows] = await db.query(
    `SELECT id FROM leases WHERE room_id = ? AND status = 'active' LIMIT 1`,
    [room_id],
  );
  return rows[0] || null;
}

async function findActiveByUserId(user_id) {
  const [rows] = await db.query(
    `SELECT id FROM leases WHERE user_id = ? AND status = 'active' LIMIT 1`,
    [user_id],
  );
  return rows[0] || null;
}

async function create({
  user_id,
  room_id,
  start_date,
  end_date,
  monthly_rent_snapshot,
  note,
}) {
  const [result] = await db.query(
    `INSERT INTO leases (user_id, room_id, start_date, end_date, status, monthly_rent_snapshot, note)
     VALUES (?, ?, ?, ?, 'active', ?, ?)`,
    [
      user_id,
      room_id,
      start_date,
      end_date || null,
      monthly_rent_snapshot,
      note || null,
    ],
  );
  return result.insertId;
}

async function updateById(id, data) {
  const allowed = ["end_date", "status", "monthly_rent_snapshot", "note"];
  const fields = [];
  const params = [];

  for (const key of allowed) {
    if (data[key] === undefined) continue;
    fields.push(`${key} = ?`);
    params.push(data[key]);
  }

  if (!fields.length) return;

  params.push(id);
  await db.query(`UPDATE leases SET ${fields.join(", ")} WHERE id = ?`, params);
}

async function deleteById(id) {
  await db.query(`DELETE FROM leases WHERE id = ?`, [id]);
}

async function setRoomAvailability(room_id, is_available) {
  await db.query(`UPDATE rooms SET is_available = ? WHERE id = ?`, [
    is_available ? 1 : 0,
    room_id,
  ]);
}

module.exports = {
  findAll,
  findById,
  findActiveByRoomId,
  findActiveByUserId,
  create,
  updateById,
  deleteById,
  setRoomAvailability,
};
