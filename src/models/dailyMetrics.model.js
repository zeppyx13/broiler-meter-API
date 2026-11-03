const db = require("../config/db");

async function cycleById(id, connection = db) {
  const [rows] = await connection.query(
    `SELECT fc.*, DATE_FORMAT(fc.placement_date, '%Y-%m-%d') AS placement_date,
       DATE_FORMAT(fc.actual_harvest_date, '%Y-%m-%d') AS actual_harvest_date,
       f.timezone, f.electricity_rate_idr_per_kwh, f.water_rate_idr_per_m3
     FROM flock_cycles fc JOIN coops c ON c.id = fc.coop_id
     JOIN farms f ON f.id = c.farm_id WHERE fc.id = ? LOCK IN SHARE MODE`,
    [id],
  );
  return rows[0] || null;
}

async function dayReadings(coopId, cycleId, start, end, connection = db) {
  const [rows] = await connection.query(
    `SELECT r.meter_id, m.device_id, m.type, m.channel, r.source,
       COUNT(*) AS reading_count,
       SUM(CASE WHEN r.reading_status = 'accepted' AND r.delta_value >= 0 THEN 1 ELSE 0 END) AS accepted_count,
       SUM(CASE WHEN r.reading_status = 'accepted' AND r.delta_value >= 0 THEN r.delta_value ELSE 0 END) AS consumption,
       MAX(CASE WHEN r.reading_status = 'accepted' AND r.delta_value >= 0 THEN r.recorded_at END) AS last_accepted_at
     FROM meter_readings r JOIN meters m ON m.id = r.meter_id
     WHERE r.coop_id = ? AND r.flock_cycle_id = ? AND r.recorded_at >= ? AND r.recorded_at < ?
     GROUP BY r.meter_id, m.device_id, m.type, m.channel, r.source LOCK IN SHARE MODE`,
    [coopId, cycleId, start, end],
  );
  return rows;
}

async function populationChanges(cycleId, date, connection = db) {
  const [[row]] = await connection.query(
    `SELECT COALESCE(SUM(population_change), 0) AS population_change
     FROM flock_events WHERE flock_cycle_id = ? AND event_date <= ? LOCK IN SHARE MODE`,
    [cycleId, date],
  );
  return Number(row.population_change);
}

async function upsert(row, connection = db) {
  await connection.query(
    `INSERT INTO daily_coop_metrics
       (coop_id, flock_cycle_id, metric_date, day_age, population_basis, water_liters,
        energy_kwh, water_liters_per_bird, energy_wh_per_bird, electricity_cost_idr, data_quality, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())
     ON DUPLICATE KEY UPDATE
       coop_id = VALUES(coop_id), day_age = VALUES(day_age), population_basis = VALUES(population_basis),
       water_liters = VALUES(water_liters), energy_kwh = VALUES(energy_kwh),
       water_liters_per_bird = VALUES(water_liters_per_bird), energy_wh_per_bird = VALUES(energy_wh_per_bird),
       electricity_cost_idr = VALUES(electricity_cost_idr), data_quality = VALUES(data_quality), computed_at = VALUES(computed_at)`,
    [
      row.coop_id,
      row.flock_cycle_id,
      row.metric_date,
      row.day_age,
      row.population_basis,
      row.water_liters ?? 0,
      row.energy_kwh ?? 0,
      row.water_liters_per_bird,
      row.energy_wh_per_bird,
      row.electricity_cost_idr ?? 0,
      row.data_quality,
    ],
  );
}

module.exports = { cycleById, dayReadings, populationChanges, upsert };
