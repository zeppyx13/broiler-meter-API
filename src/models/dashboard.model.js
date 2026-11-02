const db = require("../config/db");

async function countTotalRooms() {
  const [rows] = await db.query(`
    SELECT COUNT(*) AS totalRooms
    FROM rooms
  `);

  return Number(rows[0]?.totalRooms || 0);
}

async function countAvailableRooms() {
  const [rows] = await db.query(`
    SELECT COUNT(*) AS availableRooms
    FROM rooms
    WHERE is_available = 1
  `);

  return Number(rows[0]?.availableRooms || 0);
}

async function countTotalTenants() {
  const [rows] = await db.query(`
    SELECT COUNT(*) AS totalTenants
    FROM users
    WHERE role = 'tenant'
  `);

  return Number(rows[0]?.totalTenants || 0);
}

async function countActiveTenants() {
  const [rows] = await db.query(`
    SELECT COUNT(DISTINCT user_id) AS activeTenants
    FROM leases
    WHERE status = 'active'
  `);

  return Number(rows[0]?.activeTenants || 0);
}

async function getCurrentMonthWaterUsage() {
  const [rows] = await db.query(`
    SELECT COALESCE(SUM(water_used), 0) AS waterUsage
    FROM usage_monthly
    WHERE month = DATE_FORMAT(CURRENT_DATE(), '%Y-%m')
  `);

  return Number((rows[0]?.waterUsage / 1000 || 0).toFixed(3));
}

async function getLastMonthWaterUsage() {
  const [rows] = await db.query(`
    SELECT COALESCE(SUM(water_used), 0) AS waterUsage
    FROM usage_monthly
    WHERE month = DATE_FORMAT(DATE_SUB(CURRENT_DATE(), INTERVAL 1 MONTH), '%Y-%m')
  `);

  return Number((rows[0]?.waterUsage / 1000 || 0).toFixed(3));
}

async function getCurrentMonthElectricityUsage() {
  const [rows] = await db.query(`
    SELECT COALESCE(SUM(elec_used), 0) AS electricityUsage
    FROM usage_monthly
    WHERE month = DATE_FORMAT(CURRENT_DATE(), '%Y-%m')
  `);

  return Number(rows[0]?.electricityUsage || 0);
}

async function getLastMonthElectricityUsage() {
  const [rows] = await db.query(`
    SELECT COALESCE(SUM(elec_used), 0) AS electricityUsage
    FROM usage_monthly
    WHERE month = DATE_FORMAT(DATE_SUB(CURRENT_DATE(), INTERVAL 1 MONTH), '%Y-%m')
  `);

  return Number(rows[0]?.electricityUsage || 0);
}

async function getMonthlyUsageChart(months = 8) {
  const [rows] = await db.query(
    `
    SELECT
      month,
      COALESCE(SUM(water_used), 0)  AS water_used,
      COALESCE(SUM(elec_used),  0)  AS elec_used
    FROM usage_monthly
    WHERE month >= DATE_FORMAT(
      DATE_SUB(CURRENT_DATE(), INTERVAL ? MONTH),
      '%Y-%m'
    )
    GROUP BY month
    ORDER BY month ASC
    LIMIT ?
    `,
    [months - 1, months],
  );

  return rows.map((r) => ({
    month: r.month,
    water_used: Number((r.water_used / 1000).toFixed(3)),
    elec_used: Number(r.elec_used),
  }));
}

async function getCurrentMonthTotalIncome() {
  const [rows] = await db.query(`
    SELECT COALESCE(SUM(total_amount), 0) AS totalIncome
    FROM invoices
    WHERE month = DATE_FORMAT(CURRENT_DATE(), '%Y-%m')
      AND status IN ('paid', 'overdue')
  `);
  return Number(rows[0]?.totalIncome || 0);
}

async function countOccupiedRooms() {
  const [rows] = await db.query(`
    SELECT 
      COUNT(*) AS total,
      SUM(CASE WHEN is_available = 0 THEN 1 ELSE 0 END) AS occupied
    FROM rooms
  `);
  return {
    occupied: Number(rows[0]?.occupied || 0),
    total: Number(rows[0]?.total || 0),
  };
}

async function countInvoicesByStatus() {
  const [rows] = await db.query(`
    SELECT
      SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END)    AS paid,
      SUM(CASE WHEN status IN ('unpaid','overdue') THEN 1 ELSE 0 END) AS unpaid
    FROM invoices
    WHERE month = DATE_FORMAT(CURRENT_DATE(), '%Y-%m')
  `);
  return {
    paid: Number(rows[0]?.paid || 0),
    unpaid: Number(rows[0]?.unpaid || 0),
  };
}

async function getRoomWithHighestUsage() {
  const [rows] = await db.query(`
    SELECT r.number AS room_number
    FROM usage_monthly um
    JOIN rooms r ON r.id = um.room_id
    WHERE um.month = DATE_FORMAT(CURRENT_DATE(), '%Y-%m')
    ORDER BY (um.water_used + um.elec_used) DESC
    LIMIT 1
  `);
  return rows[0]?.room_number || null;
}

module.exports = {
  countTotalRooms,
  countAvailableRooms,
  countTotalTenants,
  countActiveTenants,
  getCurrentMonthWaterUsage,
  getLastMonthWaterUsage,
  getCurrentMonthElectricityUsage,
  getLastMonthElectricityUsage,
  getMonthlyUsageChart,
  getCurrentMonthTotalIncome,
  countOccupiedRooms,
  countInvoicesByStatus,
  getRoomWithHighestUsage,
};
