const model = require("../models/dashboardMonitoring.model");
const access = require("./access.service");
const flock = require("./flockCycle.service");
const daily = require("./dailyMetrics.service");
const { localDate } = require("../utils/farmDate");
const { presentDevice, staleSeconds } = require("../utils/deviceStatus");

const liveFields = [
  "flow_rate_lpm",
  "water_total_liter",
  "voltage_v",
  "current_a",
  "power_w",
  "energy_kwh_total",
  "frequency_hz",
  "power_factor",
];
const round = (value, digits = 6) => Number(value.toFixed(digits));

function presentLive(snapshot, source = "sensor", now = new Date()) {
  const result = {
    source,
    status: "no_data",
    recorded_at: null,
    field_status: {},
    metric_recorded_at: {},
    metric_device_id: {},
  };
  let metadata = {};
  if (snapshot?.phase_data_json) {
    try {
      metadata =
        typeof snapshot.phase_data_json === "string"
          ? JSON.parse(snapshot.phase_data_json)
          : snapshot.phase_data_json;
    } catch {
      metadata = {};
    }
  }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
    metadata = {};
  const matches = snapshot?.source === source;
  const timeoutSeconds = staleSeconds();
  for (const field of liveFields) {
    const value =
      matches && snapshot[field] != null ? Number(snapshot[field]) : null;
    const at = matches
      ? metadata.metric_recorded_at?.[field] || snapshot.recorded_at
      : null;
    const timestamp = at == null ? NaN : new Date(at).getTime();
    const age = (now.getTime() - timestamp) / 1000;
    const ambiguous =
      Array.isArray(metadata.ambiguous_metrics) &&
      metadata.ambiguous_metrics.includes(field);
    const status =
      ambiguous && matches
        ? "not_available"
        : value == null ||
            !Number.isFinite(value) ||
            !Number.isFinite(timestamp)
          ? "no_data"
          : age < -300 || age > timeoutSeconds
            ? "stale"
            : "live";
    result[field] = status === "live" ? value : null;
    result.field_status[field] = status;
    result.metric_recorded_at[field] = Number.isFinite(timestamp)
      ? new Date(timestamp).toISOString()
      : null;
    result.metric_device_id[field] = matches
      ? metadata.metric_device_id?.[field] || snapshot.device_id || null
      : null;
  }
  if (matches && snapshot.recorded_at)
    result.recorded_at = new Date(snapshot.recorded_at).toISOString();
  const states = Object.values(result.field_status);
  result.status = states.includes("live")
    ? "live"
    : states.includes("stale")
      ? "stale"
      : states.includes("not_available")
        ? "not_available"
        : "no_data";
  return result;
}

function totals(points, population = null) {
  const sum = (key) => {
    const available = points.filter((point) => point[key] != null);
    return available.length
      ? round(available.reduce((value, point) => value + point[key], 0))
      : null;
  };
  const water = sum("water_liters");
  const energy = sum("energy_kwh");
  const ambiguous = (key) =>
    points.some((point) => point.evidence.ambiguous_metrics?.includes(key));
  return {
    source: points[0]?.source || "real",
    status:
      water != null || energy != null
        ? "partial"
        : ambiguous("water_liters") || ambiguous("energy_kwh")
          ? "not_available"
          : "no_data",
    metric_status: {
      water_liters:
        water != null
          ? "partial"
          : ambiguous("water_liters")
            ? "not_available"
            : "no_data",
      energy_kwh:
        energy != null
          ? "partial"
          : ambiguous("energy_kwh")
            ? "not_available"
            : "no_data",
    },
    water_liters: water,
    energy_kwh: energy,
    electricity_cost_idr: sum("electricity_cost_idr"),
    water_cost_idr: sum("water_cost_idr"),
    population_basis: population,
    population_basis_method: "current_population_for_cycle_totals",
    water_liters_per_bird:
      water != null && population > 0 ? round(water / population) : null,
    energy_wh_per_bird:
      energy != null && population > 0
        ? round((energy * 1000) / population, 4)
        : null,
    days_with_water_data: points.filter((point) => point.water_liters != null)
      .length,
    days_with_electricity_data: points.filter(
      (point) => point.energy_kwh != null,
    ).length,
    days_in_period: points.length,
    water_accepted_intervals: points.reduce(
      (value, point) => value + point.evidence.water_accepted_intervals,
      0,
    ),
    electricity_accepted_intervals: points.reduce(
      (value, point) => value + point.evidence.electricity_accepted_intervals,
      0,
    ),
  };
}

async function resolveCoop(user, query) {
  if (query.coop_id) return access.requireCoop(user, query.coop_id);
  const coop = await access.resolveDefaultCoop(user);
  return coop ? access.requireCoop(user, coop.id) : null;
}

const definitions = {
  water:
    "Water entering the storage tank, not measured drinking intake per bird",
  electricity:
    "Aggregate energy at the metered panel, not individual blower or heater consumption",
  live_counters:
    "Live water_total_liter and energy_kwh_total are device cumulative counters; period consumption comes only from accepted deltas",
  daily_population:
    "Initial population plus recorded events through the farm-local date, including that date",
  channel_policy:
    "Per coop and metric: total channel, otherwise main, otherwise distinct phase/channel names. Competing meters for the selected aggregate or phase channel make that metric unavailable; physical topology is not inferred.",
  quality:
    "Accepted intervals only; baseline/reset/suspect/out-of-order intervals are excluded. Sampling coverage is unproven, so totals remain partial.",
  costs:
    "Estimates using the farm's current configured tariffs; historical tariff changes are not versioned",
};

async function summary(user, query) {
  const coop = await resolveCoop(user, query);
  if (!coop)
    return {
      state: "no_coop",
      coop: null,
      farm: null,
      active_cycle: null,
      live: presentLive(null),
      today: null,
      cycle_totals: null,
      devices: [],
    };
  const [farm, snapshot, devices, cycle] = await Promise.all([
    model.farm(coop.farm_id),
    model.live(coop.id),
    model.devices(coop.id),
    flock.active(user, coop.id),
  ]);
  const computed = cycle
    ? await daily.recalculateCycle({ flock_cycle_id: cycle.id })
    : null;
  const date = localDate(coop.timezone);
  const live = presentLive(snapshot);
  const result = {
    state: cycle ? "ready" : "no_active_cycle",
    coop,
    farm,
    active_cycle: cycle,
    local_date: date,
    live,
    today: computed?.real.find((point) => point.metric_date === date) || null,
    cycle_totals: computed
      ? totals(computed.real, Number(cycle.current_population))
      : null,
    devices: devices.map((device) => presentDevice(device)),
    definitions,
    generated_at: new Date().toISOString(),
  };
  result.data_status =
    live.status === "live"
      ? "live"
      : result.cycle_totals?.status === "partial"
        ? "partial"
        : live.status;
  if (query.include_simulation) {
    result.simulation = {
      source: "simulation",
      live: presentLive(snapshot, "simulation"),
      today:
        computed?.simulation.find((point) => point.metric_date === date) ||
        null,
      cycle_totals: computed
        ? {
            ...totals(computed.simulation, Number(cycle.current_population)),
            source: "simulation",
          }
        : null,
    };
  }
  return result;
}

function chartPoint(point, metric) {
  const output = { ...point };
  if (metric === "water") {
    for (const key of [
      "energy_kwh",
      "energy_wh_per_bird",
      "electricity_cost_idr",
    ])
      delete output[key];
  } else if (metric === "electricity") {
    for (const key of [
      "water_liters",
      "water_liters_per_bird",
      "water_cost_idr",
    ])
      delete output[key];
  }
  return output;
}

async function charts(user, query) {
  const coop = await resolveCoop(user, query);
  if (!coop)
    return {
      state: "no_coop",
      coop: null,
      active_cycle: null,
      source: "real",
      series: [],
    };
  const cycle = await flock.active(user, coop.id);
  if (!cycle)
    return {
      state: "no_active_cycle",
      coop,
      active_cycle: null,
      source: "real",
      series: [],
    };
  const start = query.start_date || cycle.placement_date;
  const end = query.end_date || localDate(coop.timezone);
  daily.datesBetween(start, end);
  const computed = await daily.recalculateCycle({
    flock_cycle_id: cycle.id,
    start_date: start,
    end_date: end,
  });
  const result = {
    state: "ready",
    coop_id: coop.id,
    active_cycle: cycle,
    timezone: coop.timezone,
    source: "real",
    metric: query.metric,
    range: "cycle",
    start_date: start,
    end_date: end,
    series: computed.real.map((point) => chartPoint(point, query.metric)),
    definitions,
  };
  if (query.include_simulation) {
    result.simulation = {
      source: "simulation",
      series: computed.simulation.map((point) =>
        chartPoint(point, query.metric),
      ),
    };
  }
  return result;
}

module.exports = { summary, charts, presentLive, totals };
