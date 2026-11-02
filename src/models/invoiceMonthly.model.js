const db = require("../config/db");

async function getTariffSettings() {
  const [rows] = await db.query(
    `
    SELECT
      id,
      water_rate,
      water_free_quota,
      electricity_rate,
      electricity_free_quota,
      late_fee_flat
    FROM tariff_settings
    WHERE id = 1
    LIMIT 1
    `,
  );
  return rows[0] || null;
}

async function findLeasesOverlappingMonth(startAtDate, endAtDate) {
  const [rows] = await db.query(
    `
    SELECT
      l.id AS lease_id,
      l.user_id,
      l.room_id,
      l.start_date,
      l.end_date,
      l.status,
      l.monthly_rent_snapshot,
      r.number AS room_number
    FROM leases l
    JOIN rooms r ON r.id = l.room_id
    WHERE l.start_date < ?
      AND (l.end_date IS NULL OR l.end_date >= ?)
    ORDER BY l.id ASC
    `,
    [endAtDate, startAtDate],
  );
  return rows;
}

async function findUsageMonthly(room_id, month) {
  const [rows] = await db.query(
    `
    SELECT
      water_used,
      elec_used
    FROM usage_monthly
    WHERE room_id = ? AND month = ?
    LIMIT 1
    `,
    [room_id, month],
  );
  return rows[0] || null;
}

async function findUsageMonthlyBulk(roomIds, month) {
  if (!roomIds.length) return [];
  const [rows] = await db.query(
    `
    SELECT room_id, water_used, elec_used
    FROM usage_monthly
    WHERE room_id IN (?) AND month = ?
    `,
    [roomIds, month],
  );
  return rows;
}

async function upsertInvoice({
  lease_id,
  room_id,
  user_id,
  month,
  due_date,
  rent_amount,
  water_used,
  water_cost,
  elec_used,
  elec_cost,
  fine_amount,
  discount_percent,
  discount_amount,
  total_amount,
  status,
}) {
  await db.query(
    `
    INSERT INTO invoices
      (lease_id, room_id, user_id, month, due_date,
       rent_amount,
       water_used, water_cost,
       elec_used, elec_cost,
       fine_amount, discount_percent, discount_amount,
       total_amount, status)
    VALUES
      (?, ?, ?, ?, ?,
       ?,
       ?, ?,
       ?, ?,
       ?, ?, ?,
       ?, ?)
    ON DUPLICATE KEY UPDATE
      room_id          = VALUES(room_id),
      user_id          = VALUES(user_id),
      due_date         = VALUES(due_date),
      rent_amount      = VALUES(rent_amount),
      water_used       = VALUES(water_used),
      water_cost       = VALUES(water_cost),
      elec_used        = VALUES(elec_used),
      elec_cost        = VALUES(elec_cost),
      discount_percent = VALUES(discount_percent),
      discount_amount  = VALUES(discount_amount),
      fine_amount      = IF(status IN ('overdue', 'paid'), fine_amount, VALUES(fine_amount)),
      total_amount     = IF(status IN ('overdue', 'paid'), total_amount, VALUES(total_amount)),
      status           = IF(status IN ('overdue', 'paid'), status, VALUES(status)),
      updated_at       = CURRENT_TIMESTAMP
    `,
    [
      lease_id,
      room_id,
      user_id,
      month,
      due_date,
      rent_amount,
      water_used,
      water_cost,
      elec_used,
      elec_cost,
      fine_amount,
      discount_percent,
      discount_amount,
      total_amount,
      status,
    ],
  );
}

module.exports = {
  getTariffSettings,
  findLeasesOverlappingMonth,
  findUsageMonthly,
  findUsageMonthlyBulk,
  upsertInvoice,
};
