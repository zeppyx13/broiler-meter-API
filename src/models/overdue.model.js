const db = require("../config/db");

async function findOverdueInvoices() {
  const [rows] = await db.query(
    `SELECT
       i.id,
       i.lease_id,
       i.room_id,
       i.user_id,
       i.month,
       i.due_date,
       i.rent_amount,
       i.water_cost,
       i.elec_cost,
       i.discount_amount,
       i.fine_amount,
       i.total_amount,
       i.status
     FROM invoices i
     WHERE i.status = 'unpaid'
       AND i.due_date < CURDATE()`,
  );
  return rows;
}

async function markOverdueWithFine(id, { fine_amount, total_amount }) {
  await db.query(
    `UPDATE invoices
     SET status       = 'overdue',
         fine_amount  = ?,
         total_amount = ?,
         updated_at   = CURRENT_TIMESTAMP
     WHERE id = ?
       AND status = 'unpaid'`,
    [fine_amount, total_amount, id],
  );
}

async function getLateFeeFlat() {
  const [rows] = await db.query(
    `SELECT late_fee_flat FROM tariff_settings WHERE id = 1 LIMIT 1`,
  );
  return Number(rows[0]?.late_fee_flat ?? 0);
}

module.exports = { findOverdueInvoices, markOverdueWithFine, getLateFeeFlat };
