const db = require("../config/db");

async function findAllRoomIds() {
  const [rows] = await db.query(`SELECT id FROM rooms ORDER BY id ASC`);
  return rows.map((r) => r.id);
}

async function findMeterByRoomAndType(room_id, type) {
  const [rows] = await db.query(
    `
    SELECT id, room_id, type, unit, is_active
    FROM meters
    WHERE room_id = ? AND type = ? AND is_active = 1
    LIMIT 1
    `,
    [room_id, type],
  );
  return rows[0] || null;
}

async function findLastReadingBefore(meter_id, cutoff) {
  const [rows] = await db.query(
    `
    SELECT reading_value, recorded_at
    FROM meter_readings
    WHERE meter_id = ? AND recorded_at < ?
    ORDER BY recorded_at DESC, id DESC
    LIMIT 1
    `,
    [meter_id, cutoff],
  );
  return rows[0] || null;
}
async function findFirstReadingInRange(meter_id, start, end) {
  const [rows] = await db.query(
    `
    SELECT reading_value, recorded_at
    FROM meter_readings
    WHERE meter_id = ? AND recorded_at >= ? AND recorded_at < ?
    ORDER BY recorded_at ASC, id ASC
    LIMIT 1
    `,
    [meter_id, start, end],
  );
  return rows[0] || null;
}

async function findLastReadingInRange(meter_id, start, end) {
  const [rows] = await db.query(
    `
    SELECT reading_value, recorded_at
    FROM meter_readings
    WHERE meter_id = ? AND recorded_at >= ? AND recorded_at < ?
    ORDER BY recorded_at DESC, id DESC
    LIMIT 1
    `,
    [meter_id, start, end],
  );
  return rows[0] || null;
}

async function findAllReadingsInRange(meter_id, start, end) {
  const [rows] = await db.query(
    `
    SELECT reading_value, recorded_at
    FROM meter_readings
    WHERE meter_id = ? AND recorded_at >= ? AND recorded_at < ?
    ORDER BY recorded_at ASC, id ASC
    `,
    [meter_id, start, end],
  );
  return rows;
}

async function upsertUsageMonthly({
  room_id,
  month,
  water_start,
  water_end,
  water_used,
  elec_start,
  elec_end,
  elec_used,
  computed_at,
}) {
  await db.query(
    `
    INSERT INTO usage_monthly
      (room_id, month,
       water_start, water_end, water_used,
       elec_start, elec_end, elec_used,
       computed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      water_start = VALUES(water_start),
      water_end   = VALUES(water_end),
      water_used  = VALUES(water_used),
      elec_start  = VALUES(elec_start),
      elec_end    = VALUES(elec_end),
      elec_used   = VALUES(elec_used),
      computed_at = VALUES(computed_at),
      updated_at  = CURRENT_TIMESTAMP
    `,
    [
      room_id,
      month,
      water_start,
      water_end,
      water_used,
      elec_start,
      elec_end,
      elec_used,
      computed_at,
    ],
  );
}

module.exports = {
  findAllRoomIds,
  findMeterByRoomAndType,
  findLastReadingBefore,
  findFirstReadingInRange,
  findLastReadingInRange,
  findAllReadingsInRange,
  upsertUsageMonthly,
};
