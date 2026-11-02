const db = require("../config/db");

async function findUsageMonthlyByRoomAndMonth(room_id, month) {
  const [rows] = await db.query(
    `
    SELECT
      room_id,
      month,
      water_start, water_end, water_used,
      elec_start,  elec_end,  elec_used,
      computed_at,
      created_at,
      updated_at
    FROM usage_monthly
    WHERE room_id = ? AND month = ?
    LIMIT 1
    `,
    [room_id, month],
  );
  return rows[0] || null;
}

async function findMeterIdByRoomAndType(room_id, type) {
  const [rows] = await db.query(
    `
    SELECT id, type, unit
    FROM meters
    WHERE room_id = ? AND type = ? AND is_active = 1
    LIMIT 1
    `,
    [room_id, type],
  );
  return rows[0] || null;
}

async function findMeterReadings({ meter_id, from, to, limit }) {
  const where = ["meter_id = ?"];
  const params = [meter_id];

  if (from) {
    where.push("recorded_at >= ?");
    params.push(from);
  }
  if (to) {
    where.push("recorded_at <= ?");
    params.push(to);
  }

  const whereSql = `WHERE ${where.join(" AND ")}`;

  const [rows] = await db.query(
    `
    SELECT id, reading_value, recorded_at, created_at
    FROM meter_readings
    ${whereSql}
    ORDER BY recorded_at ASC, id ASC
    LIMIT ?
    `,
    [...params, limit],
  );

  return rows;
}

module.exports = {
  findUsageMonthlyByRoomAndMonth,
  findMeterIdByRoomAndType,
  findMeterReadings,
};
