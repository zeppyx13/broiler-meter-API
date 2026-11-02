const db = require("../config/db");
async function findLatestPaymentByInvoiceId(invoice_id) {
  const [rows] = await db.query(
    `
    SELECT
      id,
      invoice_id,
      method,
      provider,
      provider_order_id,
      provider_transaction_id,
      status,
      amount,
      paid_at,
      created_at,
      updated_at
    FROM payments
    WHERE invoice_id = ?
    ORDER BY created_at DESC
    LIMIT 1
    `,
    [invoice_id],
  );
  return rows[0] || null;
}

async function findMyInvoiceByMonth(user_id, month) {
  const [rows] = await db.query(
    `
    SELECT
      i.id,
      i.lease_id,
      i.room_id,
      i.user_id,
      i.month,
      i.due_date,
      i.rent_amount,
      i.water_used,
      i.water_cost,
      i.elec_used,
      i.elec_cost,
      i.fine_amount,
      i.discount_percent,
      i.discount_amount,
      i.total_amount,
      i.status,
      i.created_at,
      i.updated_at,

      r.number AS room_number,
      r.floor AS room_floor,
      r.main_image_url AS room_main_image_url
    FROM invoices i
    JOIN rooms r ON r.id = i.room_id
    WHERE i.user_id = ? AND i.month = ?
    LIMIT 1
    `,
    [user_id, month],
  );

  return rows[0] || null;
}

async function findMyInvoices({ user_id, status, page = 1, limit = 10 }) {
  const p = Math.max(1, Number(page));
  const l = Math.min(100, Math.max(1, Number(limit)));
  const offset = (p - 1) * l;

  const where = ["i.user_id = ?"];
  const params = [user_id];

  if (status) {
    where.push("i.status = ?");
    params.push(status);
  }

  const whereSql = `WHERE ${where.join(" AND ")}`;

  const [rows] = await db.query(
    `
    SELECT
      i.id,
      i.lease_id,
      i.room_id,
      i.user_id,
      i.month,
      i.due_date,
      i.rent_amount,
      i.water_used,
      i.water_cost,
      i.elec_used,
      i.elec_cost,
      i.fine_amount,
      i.discount_percent,
      i.discount_amount,
      i.total_amount,
      i.status,
      i.created_at,
      i.updated_at,
      r.number AS room_number,
      r.floor AS room_floor,
      r.main_image_url AS room_main_image_url,
      u.name AS tenant_name
    FROM invoices i
    JOIN rooms r ON r.id = i.room_id
    JOIN users u ON u.id = i.user_id
    ${whereSql}
    ORDER BY i.month DESC, i.id DESC
    LIMIT ? OFFSET ?
    `,
    [...params, l, offset],
  );

  const [countRows] = await db.query(
    `SELECT COUNT(*) AS total FROM invoices i ${whereSql}`,
    params,
  );

  return { rows, total: countRows[0]?.total || 0, page: p, limit: l };
}

module.exports = {
  findLatestPaymentByInvoiceId,
  findMyInvoiceByMonth,
  findMyInvoices,
};
