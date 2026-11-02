const db = require("../config/db");

async function getDailyUsageByRoom(roomId, days = 30) {
  const [rows] = await db.query(
    `
    SELECT
      d.usage_date,
      d.type,
      d.unit,
      d.first_reading,
      d.last_reading,
      d.sample_count,
      GREATEST(
        COALESCE(d.last_reading - prev.last_reading, d.last_reading - d.first_reading),
        0
      ) AS usage_value
    FROM (
      SELECT
        DATE(mr.recorded_at)  AS usage_date,
        m.type,
        m.unit,
        MIN(mr.reading_value) AS first_reading,
        MAX(mr.reading_value) AS last_reading,
        COUNT(*)              AS sample_count
      FROM meter_readings mr
      INNER JOIN meters m ON m.id = mr.meter_id
      WHERE m.room_id = ?
        AND mr.recorded_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
        AND m.is_active = 1
        AND mr.reading_value > 0
      GROUP BY DATE(mr.recorded_at), m.type, m.unit
      HAVING COUNT(*) >= 2
    ) d
    LEFT JOIN (
      SELECT
        DATE(mr.recorded_at)  AS usage_date,
        m.type,
        MAX(mr.reading_value) AS last_reading
      FROM meter_readings mr
      INNER JOIN meters m ON m.id = mr.meter_id
      WHERE m.room_id = ?
        AND m.is_active = 1
        AND mr.reading_value > 0
        -- Filter +1 hari ekstra untuk cover "hari sebelumnya" dari range utama
        AND mr.recorded_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
      GROUP BY DATE(mr.recorded_at), m.type
    ) prev ON prev.type = d.type
          AND prev.usage_date = DATE_SUB(d.usage_date, INTERVAL 1 DAY)
    ORDER BY d.usage_date ASC, d.type ASC
    `,
    [roomId, days, roomId, days + 1],
  );

  return rows;
}

async function getLatestMetersByRoom(roomId) {
  const [rows] = await db.query(
    `
    SELECT
      m.id,
      m.room_id,
      m.type,
      m.unit,
      m.device_uid,
      (
        SELECT mr.reading_value
        FROM meter_readings mr
        WHERE mr.meter_id = m.id
        ORDER BY mr.recorded_at DESC, mr.id DESC
        LIMIT 1
      ) AS latest_reading_value,
      (
        SELECT mr.recorded_at
        FROM meter_readings mr
        WHERE mr.meter_id = m.id
        ORDER BY mr.recorded_at DESC, mr.id DESC
        LIMIT 1
      ) AS latest_recorded_at
    FROM meters m
    WHERE m.room_id = ?
      AND m.is_active = 1
    ORDER BY m.type ASC
    `,
    [roomId],
  );

  return rows.map((r) => ({
    ...r,
    latest_reading_value:
      r.type === "water"
        ? Number((Number(r.latest_reading_value) / 1000).toFixed(3))
        : Number(r.latest_reading_value),
  }));
}

async function getUsageHistory(roomId, months = 6) {
  const [rows] = await db.query(
    `SELECT month, water_used, elec_used
     FROM usage_monthly
     WHERE room_id = ?
     ORDER BY month DESC
     LIMIT ?`,
    [roomId, months],
  );
  return rows.reverse(); // ascending
}

async function getCurrentMonthUsage(roomId) {
  const [rows] = await db.query(
    `SELECT
       m.type,
       MIN(mr.reading_value)                                       AS start_val,
       MAX(mr.reading_value)                                       AS end_val,
       GREATEST(MAX(mr.reading_value) - MIN(mr.reading_value), 0) AS used_so_far
     FROM meters m
     JOIN meter_readings mr ON mr.meter_id = m.id
     WHERE m.room_id = ?
       AND mr.recorded_at >= DATE_FORMAT(CURRENT_DATE(), '%Y-%m-01')
       AND mr.reading_value > 0
     GROUP BY m.type
     HAVING COUNT(*) >= 2`,
    [roomId],
  );
  return rows;
}

async function getRoomPrice(roomId) {
  const [rows] = await db.query(
    `SELECT price_monthly FROM rooms WHERE id = ? LIMIT 1`,
    [roomId],
  );
  return rows[0] || null;
}

module.exports = {
  getDailyUsageByRoom,
  getLatestMetersByRoom,
  getUsageHistory,
  getCurrentMonthUsage,
  getRoomPrice,
};
