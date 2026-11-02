const db = require("../config/db");

async function findAll({ role, search, page = 1, limit = 10 } = {}) {
  const params = [role ?? null, role ?? null, search ?? null, `%${search || ""}%`, `%${search || ""}%`];
  const [rows] = await db.query(
    `SELECT id, name, email, role, phone, avatar_url, is_verified,
            default_coop_id, created_at, updated_at
     FROM users
     WHERE (? IS NULL OR role = ?) AND (? IS NULL OR name LIKE ? OR email LIKE ?)
     ORDER BY id DESC LIMIT ? OFFSET ?`,
    [...params, limit, (page - 1) * limit],
  );
  const [[{ total }]] = await db.query(
    `SELECT COUNT(*) AS total FROM users
     WHERE (? IS NULL OR role = ?) AND (? IS NULL OR name LIKE ? OR email LIKE ?)`,
    params,
  );
  return { rows, total: Number(total), page, limit };
}

async function findById(id) {
  const [rows] = await db.query(
    `SELECT id, name, email, role, phone, avatar_url, is_verified,
            default_coop_id, created_at, updated_at
     FROM users WHERE id = ? LIMIT 1`,
    [id],
  );
  return rows[0] || null;
}

async function updateById(id, data) {
  await db.query(
    `UPDATE users SET
       name = CASE WHEN ? THEN ? ELSE name END,
       phone = CASE WHEN ? THEN ? ELSE phone END,
       role = CASE WHEN ? THEN ? ELSE role END
     WHERE id = ?`,
    [data.name !== undefined, data.name ?? null,
      data.phone !== undefined, data.phone ?? null,
      data.role !== undefined, data.role ?? null, id],
  );
}

module.exports = { findAll, findById, updateById };
