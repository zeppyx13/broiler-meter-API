const db = require("../config/db");

async function findAll({ role, search, page = 1, limit = 10 } = {}) {
  const p = Math.max(1, Number(page));
  const l = Math.min(100, Math.max(1, Number(limit)));
  const offset = (p - 1) * l;

  const where = [];
  const params = [];

  if (role) {
    where.push("u.role = ?");
    params.push(role);
  }

  if (search) {
    where.push("(u.name LIKE ? OR u.email LIKE ?)");
    params.push(`%${search}%`, `%${search}%`);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const [rows] = await db.query(
    `SELECT u.id, u.name, u.email, u.role, u.phone, u.created_at, u.updated_at,
            l.id AS lease_id, l.status AS lease_status, r.number AS room_number, r.floor AS room_floor
     FROM users u
     LEFT JOIN leases l ON l.user_id = u.id AND l.status = 'active'
     LEFT JOIN rooms r ON r.id = l.room_id
     ${whereSql}
     ORDER BY u.created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, l, offset],
  );

  const [[{ total }]] = await db.query(
    `SELECT COUNT(*) AS total 
     FROM users u
     LEFT JOIN leases l ON l.user_id = u.id AND l.status = 'active'
     LEFT JOIN rooms r ON r.id = l.room_id
     ${whereSql}`,
    params,
  );

  return { rows, total: Number(total), page: p, limit: l };
}

async function findById(id) {
  const [rows] = await db.query(
    `SELECT
       u.id, u.name, u.email, u.role, u.phone,
       u.created_at, u.updated_at,
       l.id         AS lease_id,
       l.status     AS lease_status,
       l.start_date AS lease_start,
       l.end_date   AS lease_end,
       r.number     AS room_number,
       r.floor      AS room_floor
     FROM users u
     LEFT JOIN leases l ON l.user_id = u.id AND l.status = 'active'
     LEFT JOIN rooms  r ON r.id = l.room_id
     WHERE u.id = ?
     LIMIT 1`,
    [id],
  );
  return rows[0] || null;
}

async function updateById(id, data) {
  const allowed = ["name", "phone", "role"];
  const fields = [];
  const params = [];

  for (const key of allowed) {
    if (data[key] === undefined) continue;
    fields.push(`${key} = ?`);
    params.push(data[key]);
  }

  if (!fields.length) return;

  params.push(id);
  await db.query(`UPDATE users SET ${fields.join(", ")} WHERE id = ?`, params);
}

async function deleteById(id) {
  await db.query(
    `DELETE FROM payments WHERE invoice_id IN (SELECT id FROM invoices WHERE user_id = ?)`,
    [id],
  );
  await db.query(`DELETE FROM invoices  WHERE user_id = ?`, [id]);
  await db.query(`DELETE FROM reviews   WHERE user_id = ?`, [id]);
  await db.query(`DELETE FROM complaints WHERE user_id = ?`, [id]);
  await db.query(`DELETE FROM leases    WHERE user_id = ?`, [id]);
  await db.query(`DELETE FROM users     WHERE id = ?`, [id]);
}

module.exports = { findAll, findById, updateById, deleteById };
