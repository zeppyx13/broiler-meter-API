const db = require("../config/db");

async function findInvoiceById(invoice_id) {
  const [rows] = await db.query(
    `
    SELECT
      i.*,
      u.name AS user_name,
      u.email AS user_email,
      u.phone AS user_phone,
      r.number AS room_number
    FROM invoices i
    JOIN users u ON u.id = i.user_id
    JOIN rooms r ON r.id = i.room_id
    WHERE i.id = ?
    LIMIT 1
    `,
    [invoice_id],
  );
  return rows[0] || null;
}

async function findPaymentByProviderOrder(provider, provider_order_id) {
  const [rows] = await db.query(
    `
    SELECT *
    FROM payments
    WHERE provider = ? AND provider_order_id = ?
    LIMIT 1
    `,
    [provider, provider_order_id],
  );
  return rows[0] || null;
}

async function createPayment({
  invoice_id,
  method,
  provider,
  provider_order_id,
  status = "pending",
  amount,
  metadata_json = null,
}) {
  const [result] = await db.query(
    `
    INSERT INTO payments
      (invoice_id, method, provider, provider_order_id, status, amount, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    [
      invoice_id,
      method,
      provider,
      provider_order_id,
      status,
      amount,
      metadata_json,
    ],
  );
  return result.insertId;
}

async function updatePaymentById(payment_id, data) {
  const allowed = [
    "provider_transaction_id",
    "status",
    "amount",
    "paid_at",
    "metadata_json",
  ];

  const fields = [];
  const params = [];

  for (const key of allowed) {
    if (data[key] === undefined) continue;
    fields.push(`${key} = ?`);
    params.push(data[key]);
  }

  if (!fields.length) return;

  params.push(payment_id);

  await db.query(
    `UPDATE payments SET ${fields.join(", ")} WHERE id = ?`,
    params,
  );
}

async function updateInvoiceStatus(invoice_id, status) {
  await db.query(`UPDATE invoices SET status = ? WHERE id = ?`, [
    status,
    invoice_id,
  ]);
}

async function insertPaymentEvent({ payment_id, event_type, payload_json }) {
  await db.query(
    `
    INSERT INTO payment_events (payment_id, event_type, payload_json)
    VALUES (?, ?, ?)
    `,
    [payment_id, event_type, payload_json],
  );
}

async function findLatestPaymentByInvoiceId(invoice_id) {
  const [rows] = await db.query(
    `
    SELECT *
    FROM payments
    WHERE invoice_id = ?
    ORDER BY created_at DESC
    LIMIT 1
    `,
    [invoice_id],
  );
  return rows[0] || null;
}

module.exports = {
  findInvoiceById,
  findPaymentByProviderOrder,
  createPayment,
  updatePaymentById,
  updateInvoiceStatus,
  insertPaymentEvent,
  findLatestPaymentByInvoiceId,
};
