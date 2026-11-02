const db = require("../config/db");

async function findAll({
  status,
  room_id,
  user_id,
  month,
  page = 1,
  limit = 10,
}) {
  const p = Math.max(1, Number(page));
  const l = Math.min(100, Math.max(1, Number(limit)));
  const offset = (p - 1) * l;

  const where = [];
  const params = [];

  if (status) {
    where.push("i.status = ?");
    params.push(status);
  }
  if (room_id) {
    where.push("i.room_id = ?");
    params.push(room_id);
  }
  if (user_id) {
    where.push("i.user_id = ?");
    params.push(user_id);
  }
  if (month) {
    where.push("i.month = ?");
    params.push(month);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const [rows] = await db.query(
    `SELECT
       i.id, i.lease_id, i.room_id, i.user_id, i.month, i.due_date,
       i.rent_amount, i.water_used, i.water_cost,
       i.elec_used, i.elec_cost,
       i.fine_amount, i.discount_percent, i.discount_amount,
       i.total_amount, i.status,
       i.created_at, i.updated_at,
       u.name    AS tenant_name,
       u.email   AS tenant_email,
       r.number  AS room_number,
       r.floor   AS room_floor
     FROM invoices i
     JOIN users u ON u.id = i.user_id
     JOIN rooms r ON r.id = i.room_id
     ${whereSql}
     ORDER BY i.created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, l, offset],
  );

  const [[{ total }]] = await db.query(
    `SELECT COUNT(*) AS total FROM invoices i ${whereSql}`,
    params,
  );

  return { rows, total: Number(total), page: p, limit: l };
}

async function findById(id) {
  const [rows] = await db.query(
    `SELECT
       i.*,
       u.name    AS tenant_name,
       u.email   AS tenant_email,
       u.phone   AS tenant_phone,
       r.number  AS room_number,
       r.floor   AS room_floor
     FROM invoices i
     JOIN users u ON u.id = i.user_id
     JOIN rooms r ON r.id = i.room_id
     WHERE i.id = ?
     LIMIT 1`,
    [id],
  );
  return rows[0] || null;
}

async function updateById(id, data) {
  const allowed = [
    "fine_amount",
    "discount_percent",
    "discount_amount",
    "total_amount",
    "status",
    "due_date",
  ];
  const fields = [];
  const params = [];

  for (const key of allowed) {
    if (data[key] === undefined) continue;
    fields.push(`${key} = ?`);
    params.push(data[key]);
  }

  if (!fields.length) return;

  params.push(id);
  await db.query(
    `UPDATE invoices SET ${fields.join(", ")} WHERE id = ?`,
    params,
  );
}

module.exports = { findAll, findById, updateById };
