const model = require("../models/flockCycle.model");
const access = require("./access.service");
const withTransaction = require("../utils/transaction");
const httpError = require("../utils/httpError");
const { localDate, dayAge } = require("../utils/farmDate");

function present(cycle) {
  if (!cycle) return null;
  const today = localDate(cycle.timezone);
  const ageDate =
    cycle.status === "completed" && cycle.actual_harvest_date
      ? cycle.actual_harvest_date
      : today;
  return {
    ...cycle,
    day_age: dayAge(cycle.placement_date, ageDate),
    local_date: today,
  };
}

function checkPopulation(population, capacity) {
  if (population < 0) throw httpError(409, "Population cannot become negative");
  if (population > 4294967295 || (capacity != null && population > capacity)) {
    throw httpError(409, "Population exceeds coop capacity or storage limit");
  }
}

async function create(user, payload) {
  return withTransaction(async (connection) => {
    await access.lockCoop(connection, payload.coop_id);
    const coop = await access.requireCoop(
      user,
      payload.coop_id,
      "operate",
      connection,
    );
    const today = localDate(coop.timezone);
    const data = { ...payload, placement_date: payload.placement_date ?? today };
    if (data.placement_date > today)
      throw httpError(400, "Active cycle placement cannot be in the future");
    if (data.planned_harvest_date && data.planned_harvest_date < data.placement_date)
      throw httpError(400, "Planned harvest cannot precede placement");
    checkPopulation(data.initial_population, coop.capacity_birds);
    if (await model.activeForUpdate(coop.id, connection))
      throw httpError(409, "Coop already has an active cycle");
    const id = await model.create(data, connection);
    return present(await model.findById(id, connection));
  });
}

async function active(user, coopId) {
  await access.requireCoop(user, coopId);
  return present(await model.active(coopId));
}

async function list(user, query) {
  await access.requireCoop(user, query.coop_id);
  return (await model.list(query)).map(present);
}

async function get(user, id) {
  const cycle = await model.findById(id);
  if (!cycle) throw httpError(404, "Flock cycle not found");
  await access.requireCoop(user, cycle.coop_id);
  return present(cycle);
}

async function recordEvent(user, id, payload) {
  const existing = await get(user, id);
  return withTransaction(async (connection) => {
    await access.lockCoop(connection, existing.coop_id);
    const coop = await access.requireCoop(
      user,
      existing.coop_id,
      "operate",
      connection,
    );
    const cycle = await model.lockById(id, connection);
    if (cycle.status !== "active")
      throw httpError(409, "Only active cycles accept population events");
    const eventDate = payload.event_date || localDate(coop.timezone);
    if (
      eventDate < cycle.placement_date ||
      eventDate > localDate(coop.timezone)
    ) {
      throw httpError(
        400,
        "Event date must be between placement and the farm-local current date",
      );
    }
    const population =
      Number(cycle.current_population) + payload.population_change;
    checkPopulation(population, coop.capacity_birds);
    const eventId = await model.insertEvent(
      id,
      { ...payload, event_date: eventDate },
      user.id,
      connection,
    );
    await model.updatePopulation(id, population, connection);
    return {
      event_id: eventId,
      cycle: present(await model.findById(id, connection)),
    };
  });
}

async function events(user, id) {
  await get(user, id);
  return model.events(id);
}

async function complete(user, id, payload) {
  const existing = await get(user, id);
  return withTransaction(async (connection) => {
    await access.lockCoop(connection, existing.coop_id);
    const coop = await access.requireCoop(
      user,
      existing.coop_id,
      "operate",
      connection,
    );
    const cycle = await model.lockById(id, connection);
    if (cycle.status !== "active")
      throw httpError(409, "Only active cycles can be completed");
    const date = payload.actual_harvest_date || localDate(coop.timezone);
    const latestEvent = await model.latestEventDate(id, connection);
    if (
      date < cycle.placement_date ||
      date > localDate(coop.timezone) ||
      (latestEvent && date < latestEvent)
    ) {
      throw httpError(
        400,
        "Completion date must follow placement and all events, and cannot be in the future",
      );
    }
    await model.complete(id, date, connection);
    return present(await model.findById(id, connection));
  });
}

module.exports = { create, active, list, get, recordEvent, events, complete };
