const db = require("../config/db");

async function findById(id, connection = db) {
  const [rows] = await connection.query(
    `SELECT fc.*, DATE_FORMAT(fc.placement_date, '%Y-%m-%d') AS placement_date,
       DATE_FORMAT(fc.planned_harvest_date, '%Y-%m-%d') AS planned_harvest_date,
       DATE_FORMAT(fc.actual_harvest_date, '%Y-%m-%d') AS actual_harvest_date, f.timezone
     FROM flock_cycles fc JOIN coops c ON c.id = fc.coop_id
     JOIN farms f ON f.id = c.farm_id WHERE fc.id = ?`, [id],
  );
  return rows[0] || null;
}

async function lockById(id, connection) {
  const [rows] = await connection.query(
    `SELECT *, DATE_FORMAT(placement_date, '%Y-%m-%d') AS placement_date
     FROM flock_cycles WHERE id = ? FOR UPDATE`, [id],
  );
  return rows[0] || null;
}

async function active(coopId, connection = db) {
  const [rows] = await connection.query(
    `SELECT fc.*, DATE_FORMAT(fc.placement_date, '%Y-%m-%d') AS placement_date,
       DATE_FORMAT(fc.planned_harvest_date, '%Y-%m-%d') AS planned_harvest_date,
       DATE_FORMAT(fc.actual_harvest_date, '%Y-%m-%d') AS actual_harvest_date, f.timezone
     FROM flock_cycles fc JOIN coops c ON c.id = fc.coop_id
     JOIN farms f ON f.id = c.farm_id WHERE fc.coop_id = ? AND fc.status = 'active'`, [coopId],
  );
  return rows[0] || null;
}

async function activeForUpdate(coopId, connection) {
  const [rows] = await connection.query(
    "SELECT id FROM flock_cycles WHERE coop_id = ? AND status = 'active' FOR UPDATE", [coopId],
  );
  return rows[0] || null;
}

async function list({ coop_id, status, limit, offset }, connection = db) {
  const [rows] = await connection.query(
    `SELECT fc.*, DATE_FORMAT(fc.placement_date, '%Y-%m-%d') AS placement_date,
       DATE_FORMAT(fc.planned_harvest_date, '%Y-%m-%d') AS planned_harvest_date,
       DATE_FORMAT(fc.actual_harvest_date, '%Y-%m-%d') AS actual_harvest_date, f.timezone
     FROM flock_cycles fc JOIN coops c ON c.id = fc.coop_id
     JOIN farms f ON f.id = c.farm_id WHERE fc.coop_id = ? AND (? IS NULL OR fc.status = ?)
     ORDER BY fc.placement_date DESC, fc.id DESC LIMIT ? OFFSET ?`,
    [coop_id, status || null, status || null, limit, offset],
  );
  return rows;
}

async function create(payload, connection) {
  const [result] = await connection.query(
    `INSERT INTO flock_cycles
      (coop_id, cycle_code, placement_date, planned_harvest_date, initial_population, current_population, status, notes)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`,
    [payload.coop_id, payload.cycle_code, payload.placement_date, payload.planned_harvest_date || null,
      payload.initial_population, payload.initial_population, payload.notes || null],
  );
  return result.insertId;
}

async function insertEvent(cycleId, payload, userId, connection) {
  const [result] = await connection.query(
    `INSERT INTO flock_events (flock_cycle_id, event_type, population_change, event_date, notes, recorded_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [cycleId, payload.event_type, payload.population_change, payload.event_date, payload.notes || null, userId],
  );
  return result.insertId;
}

async function updatePopulation(id, population, connection) {
  await connection.query("UPDATE flock_cycles SET current_population = ? WHERE id = ?", [population, id]);
}

async function events(id, connection = db) {
  const [rows] = await connection.query(
    `SELECT *, DATE_FORMAT(event_date, '%Y-%m-%d') AS event_date
     FROM flock_events WHERE flock_cycle_id = ? ORDER BY event_date, id`, [id],
  );
  return rows;
}

async function latestEventDate(id, connection) {
  const [rows] = await connection.query(
    `SELECT DATE_FORMAT(event_date, '%Y-%m-%d') AS event_date FROM flock_events
     WHERE flock_cycle_id = ? ORDER BY event_date DESC, id DESC LIMIT 1 FOR UPDATE`, [id],
  );
  return rows[0]?.event_date || null;
}

async function complete(id, date, connection) {
  await connection.query(
    "UPDATE flock_cycles SET status = 'completed', actual_harvest_date = ? WHERE id = ?", [date, id],
  );
}

module.exports = { findById, lockById, active, activeForUpdate, list, create, insertEvent, updatePopulation, events, latestEventDate, complete };
