const db = require("../config/db");

async function findActiveAnnouncements({ page = 1, limit = 20 }) {
  const p = Math.max(1, Number(page));
  const l = Math.min(100, Math.max(1, Number(limit)));
  const offset = (p - 1) * l;

  const [rows] = await db.query(
    `SELECT id, title, body, start_at, end_at, is_active, created_at
     FROM announcements
     WHERE is_active = 1
       AND (start_at IS NULL OR start_at <= UTC_TIMESTAMP())
       AND (end_at IS NULL OR end_at >= UTC_TIMESTAMP())
     ORDER BY created_at DESC
     LIMIT ? OFFSET ?`,
    [l, offset],
  );

  const [countRows] = await db.query(
    `SELECT COUNT(*) AS total
     FROM announcements
     WHERE is_active = 1
       AND (start_at IS NULL OR start_at <= UTC_TIMESTAMP())
       AND (end_at IS NULL OR end_at >= UTC_TIMESTAMP())`,
  );

  return { rows, total: countRows[0]?.total || 0, page: p, limit: l };
}

async function findAll({ page = 1, limit = 10, is_active } = {}) {
  const p = Math.max(1, Number(page));
  const l = Math.min(100, Math.max(1, Number(limit)));
  const offset = (p - 1) * l;

  const where = [];
  const params = [];

  if (is_active !== undefined && is_active !== null && is_active !== "") {
    where.push("is_active = ?");
    params.push(Number(is_active));
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const [rows] = await db.query(
    `SELECT id, title, body, is_active, start_at, end_at, created_at
     FROM announcements
     ${whereSql}
     ORDER BY created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, l, offset],
  );

  const [[{ total }]] = await db.query(
    `SELECT COUNT(*) AS total FROM announcements ${whereSql}`,
    params,
  );

  return { rows, total: Number(total), page: p, limit: l };
}

async function findById(id) {
  const [rows] = await db.query(
    `SELECT * FROM announcements WHERE id = ? LIMIT 1`,
    [id],
  );
  return rows[0] || null;
}

async function create({ title, body, is_active = true, start_at, end_at }) {
  const [result] = await db.query(
    `INSERT INTO announcements (title, body, is_active, start_at, end_at)
     VALUES (?, ?, ?, ?, ?)`,
    [title, body, is_active ? 1 : 0, start_at || null, end_at || null],
  );
  return result.insertId;
}

async function updateById(id, data) {
  const allowed = ["title", "body", "is_active", "start_at", "end_at"];
  const fields = [];
  const params = [];

  for (const key of allowed) {
    if (data[key] === undefined) continue;
    fields.push(`${key} = ?`);
    params.push(key === "is_active" ? (data[key] ? 1 : 0) : data[key]);
  }

  if (!fields.length) return;

  params.push(id);
  await db.query(
    `UPDATE announcements SET ${fields.join(", ")} WHERE id = ?`,
    params,
  );
}

async function deleteById(id) {
  await db.query(`DELETE FROM announcements WHERE id = ?`, [id]);
}

module.exports = {
  findActiveAnnouncements,
  findAll,
  findById,
  create,
  updateById,
  deleteById,
};
