const db = require("../config/db");

async function list(meterId, query) {
  const [rows] = await db.query(
    `SELECT id, meter_id, coop_id, flock_cycle_id, reading_value, delta_value,
       counter_epoch, reading_status, source, recorded_at, received_at
     FROM meter_readings WHERE meter_id = ? AND (? IS NULL OR recorded_at >= ?)
       AND (? IS NULL OR recorded_at <= ?) AND (? IS NULL OR id < ?)
       AND (? = 'all' OR (? = 'simulation' AND source = 'simulation') OR (? = 'real' AND source <> 'simulation'))
     ORDER BY id DESC LIMIT ?`,
    [
      meterId,
      query.from ? new Date(query.from) : null,
      query.from ? new Date(query.from) : null,
      query.to ? new Date(query.to) : null,
      query.to ? new Date(query.to) : null,
      query.before_id || null,
      query.before_id || null,
      query.source,
      query.source,
      query.source,
      query.limit,
    ],
  );
  return rows;
}

module.exports = { list };
