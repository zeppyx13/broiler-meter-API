const db = require("../config/db");

async function findAll({ status, invoice_id, page = 1, limit = 10 } = {}) {
  const p = Math.max(1, Number(page));
  const l = Math.min(100, Math.max(1, Number(limit)));
  const offset = (p - 1) * l;

  const where = [];
  const params = [];

  if (status) {
    where.push("p.status = ?");
    params.push(status);
  }
  if (invoice_id) {
    where.push("p.invoice_id = ?");
    params.push(invoice_id);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const [rows] = await db.query(
    `SELECT
       p.id, p.invoice_id, p.method, p.provider,
       p.provider_order_id, p.provider_transaction_id,
       p.status, p.amount, p.paid_at,
       p.created_at, p.updated_at,
       i.month        AS invoice_month,
       i.total_amount AS invoice_total,
       u.name         AS tenant_name,
       u.email        AS tenant_email,
       r.number       AS room_number
     FROM payments p
     JOIN invoices i ON i.id = p.invoice_id
     JOIN users u    ON u.id = i.user_id
     JOIN rooms r    ON r.id = i.room_id
     ${whereSql}
     ORDER BY p.created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, l, offset],
  );

  const [[{ total }]] = await db.query(
    `SELECT COUNT(*) AS total FROM payments p ${whereSql}`,
    params,
  );

  return { rows, total: Number(total), page: p, limit: l };
}

async function findById(id) {
  const [rows] = await db.query(
    `SELECT
       p.*,
       i.month        AS invoice_month,
       i.total_amount AS invoice_total,
       u.name         AS tenant_name,
       u.email        AS tenant_email,
       u.phone        AS tenant_phone,
       r.number       AS room_number,
       r.floor        AS room_floor
     FROM payments p
     JOIN invoices i ON i.id = p.invoice_id
     JOIN users u    ON u.id = i.user_id
     JOIN rooms r    ON r.id = i.room_id
     WHERE p.id = ?
     LIMIT 1`,
    [id],
  );
  return rows[0] || null;
}

async function findEventsByPaymentId(payment_id) {
  const [rows] = await db.query(
    `SELECT id, event_type, payload_json, received_at
     FROM payment_events
     WHERE payment_id = ?
     ORDER BY received_at ASC`,
    [payment_id],
  );
  return rows;
}

module.exports = { findAll, findById, findEventsByPaymentId };
