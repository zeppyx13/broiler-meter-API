const model = require("../models/dailyMetrics.model");
const access = require("./access.service");
const withTransaction = require("../utils/transaction");
const httpError = require("../utils/httpError");
const { localDate, dayAge } = require("../utils/farmDate");

const round = (value, digits = 6) => Number(value.toFixed(digits));
const nextDate = (date) =>
  new Date(Date.parse(date) + 86400000).toISOString().slice(0, 10);

// Find local-calendar boundaries without depending on MySQL's optional timezone tables.
function calendarBoundary(date, timezone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const calendar = (instant) => {
    const parts = formatter.formatToParts(new Date(instant));
    const part = (type) => parts.find((item) => item.type === type).value;
    return `${part("year")}-${part("month")}-${part("day")}`;
  };
  let low = Date.parse(date) - 36 * 3600000;
  let high = Date.parse(date) + 36 * 3600000;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (calendar(middle) < date) low = middle + 1;
    else high = middle;
  }
  return new Date(low);
}

function datesBetween(start, end, maximum = 366) {
  if (start > end) throw httpError(400, "Start date must not follow end date");
  if (dayAge(start, end) > maximum)
    throw httpError(400, `Date range cannot exceed ${maximum} days`);
  const dates = [];
  for (let date = start; date <= end; date = nextDate(date)) dates.push(date);
  return dates;
}

function selectChannels(groups) {
  const partitions = new Map();
  for (const group of groups.filter(
    (item) => Number(item.accepted_count) > 0,
  )) {
    const key = group.type;
    if (!partitions.has(key)) partitions.set(key, []);
    partitions.get(key).push(group);
  }
  const included = [];
  const excluded = [];
  const ambiguous = [];
  for (const partition of partitions.values()) {
    const channels = partition.map((item) =>
      String(item.channel).toLowerCase(),
    );
    const preferred = channels.includes("total")
      ? "total"
      : channels.includes("main")
        ? "main"
        : null;
    const candidates = partition.filter(
      (item) => !preferred || String(item.channel).toLowerCase() === preferred,
    );
    const metersByChannel = new Map();
    for (const item of candidates) {
      const channel = String(item.channel).toLowerCase();
      if (!metersByChannel.has(channel))
        metersByChannel.set(channel, new Set());
      metersByChannel.get(channel).add(String(item.meter_id));
    }
    if ([...metersByChannel.values()].some((meters) => meters.size > 1)) {
      ambiguous.push(partition[0].type);
      excluded.push(...partition);
      continue;
    }
    for (const group of partition) {
      (preferred && String(group.channel).toLowerCase() !== preferred
        ? excluded
        : included
      ).push(group);
    }
  }
  return { included, excluded, ambiguous };
}

function buildDaily(cycle, date, population, groups, stream) {
  const rows = groups.filter(
    (item) => (item.source === "simulation") === (stream === "simulation"),
  );
  const { included, excluded, ambiguous } = selectChannels(rows);
  const metric = (type) => {
    const items = included.filter((item) => item.type === type);
    const count = items.reduce(
      (sum, item) => sum + Number(item.accepted_count),
      0,
    );
    return {
      count,
      value: count
        ? round(items.reduce((sum, item) => sum + Number(item.consumption), 0))
        : null,
    };
  };
  const water = metric("water");
  const electricity = metric("electricity");
  const dates = included
    .map((item) => item.last_accepted_at)
    .filter(Boolean)
    .map((value) => new Date(value).getTime());
  return {
    coop_id: cycle.coop_id,
    flock_cycle_id: cycle.id,
    metric_date: date,
    day_age: dayAge(cycle.placement_date, date),
    population_basis: population,
    population_basis_method: "end_of_local_day",
    source: stream,
    data_quality: stream === "simulation" ? "simulated" : "partial",
    status:
      water.count || electricity.count
        ? "partial"
        : ambiguous.length
          ? "not_available"
          : "no_data",
    metric_status: {
      water_liters: water.count
        ? "partial"
        : ambiguous.includes("water")
          ? "not_available"
          : "no_data",
      energy_kwh: electricity.count
        ? "partial"
        : ambiguous.includes("electricity")
          ? "not_available"
          : "no_data",
    },
    water_liters: water.value,
    energy_kwh: electricity.value,
    water_liters_per_bird:
      water.value != null && population > 0
        ? round(water.value / population)
        : null,
    energy_wh_per_bird:
      electricity.value != null && population > 0
        ? round((electricity.value * 1000) / population, 4)
        : null,
    electricity_cost_idr:
      electricity.value != null
        ? round(
            electricity.value * Number(cycle.electricity_rate_idr_per_kwh),
            2,
          )
        : null,
    water_cost_idr:
      water.value != null
        ? round((water.value / 1000) * Number(cycle.water_rate_idr_per_m3), 2)
        : null,
    evidence: {
      reading_count: rows.reduce(
        (sum, item) => sum + Number(item.reading_count),
        0,
      ),
      water_accepted_intervals: water.count,
      electricity_accepted_intervals: electricity.count,
      included_meter_ids: [...new Set(included.map((item) => item.meter_id))],
      excluded_overlap_meter_ids: [
        ...new Set(excluded.map((item) => item.meter_id)),
      ],
      ambiguous_metrics: ambiguous.map((type) =>
        type === "water" ? "water_liters" : "energy_kwh",
      ),
      sources: [...new Set(included.map((item) => item.source))],
    },
    last_reading_at: dates.length
      ? new Date(Math.max(...dates)).toISOString()
      : null,
  };
}

async function recalculateCycle({ flock_cycle_id, start_date, end_date, recorded_at }) {
  // Route to the parent without taking a cycle lock before the canonical farm -> coop locks.
  const existing = await model.cycleLocation(flock_cycle_id);
  if (!existing) throw httpError(404, "Flock cycle not found");
  return withTransaction(async (connection) => {
    await access.lockCoop(connection, existing.coop_id);
    const cycle = await model.cycleById(flock_cycle_id, connection);
    const today = localDate(cycle.timezone);
    const last = cycle.actual_harvest_date || today;
    const readingDate = recorded_at ? localDate(cycle.timezone, new Date(recorded_at)) : null;
    if (readingDate && (readingDate < cycle.placement_date ||
      (cycle.actual_harvest_date && readingDate > cycle.actual_harvest_date))) return { skipped: true };
    const start = readingDate || start_date || cycle.placement_date;
    const end = readingDate || end_date || last;
    if (start < cycle.placement_date || end > last) {
      throw httpError(
        400,
        "Metric dates must lie within the cycle and farm-local current date",
      );
    }
    // Summary may cover a longer historical cycle; public chart requests are bounded separately.
    const dates = datesBetween(start, end, 65535);
    const real = [];
    const simulation = [];
    let boundary = calendarBoundary(start, cycle.timezone);
    for (const date of dates) {
      const endBoundary = calendarBoundary(nextDate(date), cycle.timezone);
      const groups = await model.dayReadings(
        cycle.coop_id,
        cycle.id,
        boundary,
        endBoundary,
        connection,
      );
      const population =
        Number(cycle.initial_population) +
        (await model.populationChanges(cycle.id, date, connection));
      if (population < 0 || population > 4294967295) {
        throw httpError(
          409,
          "Historical population is outside valid bounds; review flock events",
        );
      }
      const actual = buildDaily(cycle, date, population, groups, "real");
      const simulated = buildDaily(
        cycle,
        date,
        population,
        groups,
        "simulation",
      );
      real.push(actual);
      simulation.push(simulated);
      // A real baseline/reset is evidence of missing real consumption, never permission to substitute simulation.
      const persisted = actual.evidence.reading_count ? actual : simulated;
      if (persisted.evidence.reading_count)
        await model.upsert(persisted, connection);
      boundary = endBoundary;
    }
    return { cycle, real, simulation };
  });
}

async function recalculateForReading({ coop_id, flock_cycle_id, recorded_at }) {
  if (!flock_cycle_id) return { skipped: true };
  const cycle = await model.cycleLocation(flock_cycle_id);
  if (!cycle || String(cycle.coop_id) !== String(coop_id))
    return { skipped: true };
  return recalculateCycle({ flock_cycle_id, recorded_at });
}

module.exports = {
  recalculateCycle,
  recalculateForReading,
  buildDaily,
  selectChannels,
  calendarBoundary,
  datesBetween,
};
