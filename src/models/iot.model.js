const db = require("../config/db");

async function findLastReading(meter_id) {
  const [rows] = await db.query(
    `
    SELECT id, reading_value, recorded_at
    FROM meter_readings
    WHERE meter_id = ?
    ORDER BY recorded_at DESC, id DESC
    LIMIT 1
    `,
    [meter_id],
  );
  return rows[0] || null;
}

async function insertReading({ meter_id, reading_value, recorded_at }) {
  const [result] = await db.query(
    `
    INSERT INTO meter_readings (meter_id, reading_value, recorded_at)
    VALUES (?, ?, ?)
    `,
    [meter_id, reading_value, recorded_at],
  );
  return result.insertId;
}

async function upsertLiveStatus({
  room_id,
  flow_rate_lpm,
  water_total_liter,
  voltage,
  current,
  power,
  energy_kwh_total,
  frequency,
  pf,
  recorded_at,
}) {
  const [result] = await db.query(
    `
    INSERT INTO room_live_status
    (
      room_id,
      flow_rate_lpm,
      water_total_liter,
      voltage,
      current,
      power,
      energy_kwh_total,
      frequency,
      pf,
      recorded_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      flow_rate_lpm = VALUES(flow_rate_lpm),
      water_total_liter = VALUES(water_total_liter),
      voltage = VALUES(voltage),
      current = VALUES(current),
      power = VALUES(power),
      energy_kwh_total = VALUES(energy_kwh_total),
      frequency = VALUES(frequency),
      pf = VALUES(pf),
      recorded_at = VALUES(recorded_at)
    `,
    [
      room_id,
      flow_rate_lpm,
      water_total_liter,
      voltage,
      current,
      power,
      energy_kwh_total,
      frequency,
      pf,
      recorded_at,
    ],
  );

  return result;
}

async function findAllLiveStatus() {
  const [rows] = await db.query(
    `
    SELECT
      rls.room_id,
      r.number,
      rls.flow_rate_lpm,
      rls.water_total_liter,
      rls.voltage,
      rls.current,
      rls.power,
      rls.energy_kwh_total,
      rls.frequency,
      rls.pf,
      rls.recorded_at,
      rls.updated_at
    FROM room_live_status rls
    LEFT JOIN rooms r ON r.id = rls.room_id
    ORDER BY rls.room_id ASC
    `,
  );

  return rows;
}

async function findLiveStatusByRoomId(room_id) {
  const [rows] = await db.query(
    `
    SELECT
      rls.room_id,
      r.number,
      rls.flow_rate_lpm,
      rls.water_total_liter,
      rls.voltage,
      rls.current,
      rls.power,
      rls.energy_kwh_total,
      rls.frequency,
      rls.pf,
      rls.recorded_at,
      rls.updated_at
    FROM room_live_status rls
    LEFT JOIN rooms r ON r.id = rls.room_id
    WHERE rls.room_id = ?
    LIMIT 1
    `,
    [room_id],
  );

  return rows[0] || null;
}
async function findActiveDeviceByRoomId(roomId) {
  const [rows] = await db.query(
    `SELECT r.id, m.device_uid
     FROM rooms r
     JOIN meters m ON m.room_id = r.id
     WHERE r.id = ? AND m.is_active = 1
     LIMIT 1`,
    [roomId],
  );
  return rows[0] || null;
}
module.exports = {
  findLastReading,
  insertReading,
  upsertLiveStatus,
  findAllLiveStatus,
  findLiveStatusByRoomId,
  findActiveDeviceByRoomId,
};
