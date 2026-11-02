const db = require("../config/db");

async function getDashboardContext() {
  const currentMonth = new Date().toISOString().slice(0, 7);

  const [
    [[roomStats]],
    [[invoiceStats]],
    [[complaintStats]],
    [expiringSoonLeases],
    [overdueInvoices],
    [openComplaints],
    [longestEmptyRooms],
    [topComplaintRooms],
    [usageStats],
    [ratingStats],
  ] = await Promise.all([
    db.query(`
    SELECT
      COUNT(*) AS total_rooms,
      SUM(CASE WHEN is_available = 0 THEN 1 ELSE 0 END) AS occupied_rooms,
      SUM(CASE WHEN is_available = 1 THEN 1 ELSE 0 END) AS available_rooms
    FROM rooms
  `),
    db.query(
      `
    SELECT
      COUNT(*) AS total_invoices,
      SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END) AS paid,
      SUM(CASE WHEN status = 'unpaid' THEN 1 ELSE 0 END) AS unpaid,
      SUM(CASE WHEN status = 'overdue' THEN 1 ELSE 0 END) AS overdue,
      COALESCE(SUM(CASE WHEN status IN ('paid') THEN total_amount END), 0) AS total_income,
      COALESCE(SUM(CASE WHEN status IN ('unpaid', 'overdue') THEN total_amount END), 0) AS total_receivable
    FROM invoices
    WHERE month = ?
  `,
      [currentMonth],
    ),
    db.query(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open_count,
      SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) AS in_progress_count,
      SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) AS closed_count
    FROM complaints
  `),
    db.query(`
    SELECT l.id, u.name AS tenant_name, r.number AS room_number,
           l.end_date, DATEDIFF(l.end_date, CURDATE()) AS days_remaining
    FROM leases l
    JOIN users u ON u.id = l.user_id
    JOIN rooms r ON r.id = l.room_id
    WHERE l.status = 'active'
      AND l.end_date IS NOT NULL
      AND l.end_date BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 30 DAY)
    ORDER BY l.end_date ASC
  `),
    db.query(`
    SELECT i.id, u.name AS tenant_name, r.number AS room_number,
           i.total_amount, i.due_date, i.month,
           DATEDIFF(CURDATE(), i.due_date) AS days_overdue
    FROM invoices i
    JOIN users u ON u.id = i.user_id
    JOIN rooms r ON r.id = i.room_id
    WHERE i.status IN ('unpaid', 'overdue')
    ORDER BY i.due_date ASC
    LIMIT 10
  `),
    db.query(`
    SELECT c.id, c.title, c.status, c.created_at,
           u.name AS tenant_name, r.number AS room_number,
           DATEDIFF(CURDATE(), DATE(c.created_at)) AS days_open
    FROM complaints c
    JOIN users u ON u.id = c.user_id
    JOIN rooms r ON r.id = c.room_id
    WHERE c.status IN ('open', 'in_progress')
    ORDER BY c.created_at ASC
    LIMIT 10
  `),
    db.query(`
    SELECT r.number, r.floor, r.price_monthly,
           DATEDIFF(CURDATE(), COALESCE(
             (SELECT MAX(l2.end_date) FROM leases l2 WHERE l2.room_id = r.id AND l2.status = 'ended'),
             r.created_at
           )) AS days_empty
    FROM rooms r
    WHERE r.is_available = 1
    ORDER BY days_empty DESC
    LIMIT 5
  `),
    db.query(`
    SELECT r.number, COUNT(c.id) AS complaint_count
    FROM complaints c
    JOIN rooms r ON r.id = c.room_id
    GROUP BY r.id, r.number
    ORDER BY complaint_count DESC
    LIMIT 5
  `),
    db.query(
      `
    SELECT r.number AS room_number,
           um.water_used, um.elec_used
    FROM usage_monthly um
    JOIN rooms r ON r.id = um.room_id
    WHERE um.month = ?
    ORDER BY um.water_used DESC
  `,
      [currentMonth],
    ),
    db.query(`
    SELECT r.number AS room_number,
           ROUND(AVG(rv.rating), 1) AS avg_rating,
           COUNT(rv.id) AS review_count
    FROM rooms r
    LEFT JOIN reviews rv ON rv.room_id = r.id
    GROUP BY r.id, r.number
    ORDER BY avg_rating ASC
    LIMIT 5
  `),
  ]);

  return {
    current_month: currentMonth,
    room_stats: roomStats,
    invoice_stats: invoiceStats,
    complaint_stats: complaintStats,
    expiring_leases: expiringSoonLeases,
    overdue_invoices: overdueInvoices,
    open_complaints: openComplaints,
    longest_empty_rooms: longestEmptyRooms,
    top_complaint_rooms: topComplaintRooms,
    usage_this_month: usageStats,
    lowest_rated_rooms: ratingStats,
  };
}

module.exports = { getDashboardContext };
