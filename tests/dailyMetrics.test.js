const { test } = require("node:test");
const assert = require("node:assert/strict");
const db = require("../src/config/db");
const model = require("../src/models/dailyMetrics.model");
const access = require("../src/services/access.service");
const daily = require("../src/services/dailyMetrics.service");
const monitoring = require("../src/services/dashboardMonitoring.service");
const monitoringModel = require("../src/models/dashboardMonitoring.model");
const flock = require("../src/services/flockCycle.service");
const validator = require("../src/validators/dashboardMonitoring.validator");

const cycle = {
  id: 3,
  coop_id: 2,
  placement_date: "2026-11-03",
  actual_harvest_date: null,
  initial_population: 100,
  current_population: 98,
  timezone: "Asia/Makassar",
  electricity_rate_idr_per_kwh: "1500.00",
  water_rate_idr_per_m3: "2000.00",
};
function group(overrides = {}) {
  return {
    meter_id: 1,
    device_id: 1,
    type: "water",
    channel: "main",
    source: "mqtt",
    reading_count: 2,
    accepted_count: 1,
    consumption: "20.000000",
    last_accepted_at: new Date("2026-11-03T04:00:00Z"),
    ...overrides,
  };
}

test("local-calendar boundaries use WITA and daylight-saving days without MySQL timezone tables", () => {
  assert.equal(
    daily.calendarBoundary("2026-11-04", "Asia/Makassar").toISOString(),
    "2026-11-03T16:00:00.000Z",
  );
  assert.equal(
    daily.calendarBoundary("2026-03-08", "America/Los_Angeles").toISOString(),
    "2026-03-08T08:00:00.000Z",
  );
  assert.equal(
    daily.calendarBoundary("2026-03-09", "America/Los_Angeles").toISOString(),
    "2026-03-09T07:00:00.000Z",
  );
});

test("daily normalization uses Day 1, end-of-day population, liters and Wh per bird", () => {
  const point = daily.buildDaily(
    cycle,
    "2026-11-03",
    98,
    [group(), group({ meter_id: 2, type: "electricity", consumption: "2.5" })],
    "real",
  );
  assert.equal(point.day_age, 1);
  assert.equal(point.population_basis, 98);
  assert.equal(point.water_liters, 20);
  assert.equal(point.energy_kwh, 2.5);
  assert.equal(point.water_liters_per_bird, 0.204082);
  assert.equal(point.energy_wh_per_bird, 25.5102);
  assert.equal(point.electricity_cost_idr, 3750);
  assert.equal(point.water_cost_idr, 40);
  assert.equal(point.data_quality, "partial");
});

test("real and simulated streams remain separate, including per-metric absence", () => {
  const groups = [
    group(),
    group({
      meter_id: 2,
      type: "electricity",
      source: "simulation",
      consumption: "9",
    }),
  ];
  const real = daily.buildDaily(cycle, "2026-11-03", 100, groups, "real");
  const simulation = daily.buildDaily(
    cycle,
    "2026-11-03",
    100,
    groups,
    "simulation",
  );
  assert.equal(real.water_liters, 20);
  assert.equal(real.energy_kwh, null);
  assert.equal(real.electricity_cost_idr, null);
  assert.equal(simulation.water_liters, null);
  assert.equal(simulation.energy_kwh, 9);
  assert.equal(simulation.data_quality, "simulated");
});

test("overlapping total/main and phase channels are not counted together", () => {
  const point = daily.buildDaily(
    cycle,
    "2026-11-03",
    100,
    [
      group({
        meter_id: 1,
        type: "electricity",
        channel: "total",
        consumption: "3",
      }),
      group({
        meter_id: 2,
        type: "electricity",
        channel: "main",
        consumption: "3",
      }),
      group({
        meter_id: 3,
        type: "electricity",
        channel: "L1",
        consumption: "1",
      }),
      group({
        meter_id: 4,
        type: "electricity",
        channel: "L2",
        consumption: "1",
      }),
      group({
        meter_id: 5,
        type: "electricity",
        channel: "L3",
        consumption: "1",
      }),
    ],
    "real",
  );
  assert.equal(point.energy_kwh, 3);
  assert.deepEqual(point.evidence.included_meter_ids, [1]);
  assert.deepEqual(point.evidence.excluded_overlap_meter_ids, [2, 3, 4, 5]);
  const phases = daily.buildDaily(
    cycle,
    "2026-11-03",
    100,
    [
      group({ type: "electricity", channel: "L1", consumption: "1" }),
      group({
        meter_id: 2,
        type: "electricity",
        channel: "L2",
        consumption: "2",
      }),
    ],
    "real",
  );
  assert.equal(phases.energy_kwh, 3);
});

test("missing intervals stay null, a valid zero stays zero, and zero population has no per-bird ratio", () => {
  const missing = daily.buildDaily(
    cycle,
    "2026-11-03",
    0,
    [group({ accepted_count: 0, consumption: "0" })],
    "real",
  );
  assert.equal(missing.water_liters, null);
  assert.equal(missing.energy_kwh, null);
  assert.equal(missing.status, "no_data");
  const zero = daily.buildDaily(
    cycle,
    "2026-11-03",
    0,
    [group({ consumption: "0" })],
    "real",
  );
  assert.equal(zero.water_liters, 0);
  assert.equal(zero.water_liters_per_bird, null);
});

test("cross-device aggregates exclude phases and competing mains become unavailable", () => {
  const groups = [
    group({
      meter_id: 1,
      device_id: 1,
      type: "electricity",
      channel: "main",
      consumption: "4",
    }),
    group({
      meter_id: 2,
      device_id: 2,
      type: "electricity",
      channel: "L1",
      consumption: "1",
    }),
  ];
  const aggregate = daily.buildDaily(cycle, "2026-11-03", 100, groups, "real");
  assert.equal(aggregate.energy_kwh, 4);
  assert.deepEqual(aggregate.evidence.excluded_overlap_meter_ids, [2]);
  const competing = daily.buildDaily(
    cycle,
    "2026-11-03",
    100,
    [
      ...groups,
      group({
        meter_id: 3,
        device_id: 3,
        type: "electricity",
        channel: "main",
        consumption: "8",
      }),
    ],
    "real",
  );
  assert.equal(competing.energy_kwh, null);
  assert.equal(competing.metric_status.energy_kwh, "not_available");
  assert.deepEqual(competing.evidence.ambiguous_metrics, ["energy_kwh"]);
  const water = daily.buildDaily(
    cycle,
    "2026-11-03",
    100,
    [group(), group({ meter_id: 4, device_id: 4 })],
    "real",
  );
  assert.equal(water.water_liters, null);
  assert.equal(water.metric_status.water_liters, "not_available");
});

test("the same meter using mqtt and http is one channel, while duplicate phase meters are ambiguous", () => {
  const groups = [group(), group({ source: "http", consumption: "5" })];
  const actual = daily.buildDaily(cycle, "2026-11-03", 100, groups, "real");
  assert.equal(actual.water_liters, 25);
  assert.deepEqual(actual.evidence.ambiguous_metrics, []);
  const phases = daily.buildDaily(
    cycle,
    "2026-11-03",
    100,
    [
      group({ type: "electricity", channel: "L1" }),
      group({ meter_id: 2, device_id: 2, type: "electricity", channel: "L1" }),
    ],
    "real",
  );
  assert.equal(phases.energy_kwh, null);
});

test("recalculation reruns replace the same day and real baselines prevent simulation substitution", async (t) => {
  const stored = new Map();
  const connection = {
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    release() {},
  };
  t.mock.method(db, "getConnection", async () => connection);
  t.mock.method(access, "lockCoop", async () => {});
  t.mock.method(model, "cycleById", async () => ({ ...cycle }));
  t.mock.method(model, "dayReadings", async () => [
    group({ accepted_count: 0, consumption: "0" }),
    group({ source: "simulation", consumption: "70" }),
  ]);
  t.mock.method(model, "populationChanges", async () => -2);
  t.mock.method(model, "upsert", async (row) =>
    stored.set(`${row.flock_cycle_id}:${row.metric_date}`, row),
  );
  for (let run = 0; run < 2; run++) {
    const result = await daily.recalculateCycle({
      flock_cycle_id: 3,
      start_date: "2026-11-03",
      end_date: "2026-11-03",
    });
    assert.equal(result.real[0].water_liters, null);
    assert.equal(result.simulation[0].water_liters, 70);
  }
  assert.equal(stored.size, 1);
  assert.equal(stored.values().next().value.data_quality, "partial");
  assert.equal(stored.values().next().value.water_liters, null);
  assert.equal(stored.values().next().value.population_basis, 98);
});

test("single-reading refresh recomputes the farm-local date after commit", async (t) => {
  const connection = {
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    release() {},
  };
  t.mock.method(db, "getConnection", async () => connection);
  t.mock.method(access, "lockCoop", async () => {});
  t.mock.method(model, "cycleById", async () => ({ ...cycle }));
  t.mock.method(model, "populationChanges", async () => 0);
  t.mock.method(model, "dayReadings", async (coop, id, start, end) => {
    assert.equal(start.toISOString(), "2026-11-03T16:00:00.000Z");
    assert.equal(end.toISOString(), "2026-11-04T16:00:00.000Z");
    return [];
  });
  const result = await daily.recalculateForReading({
    coop_id: 2,
    flock_cycle_id: 3,
    recorded_at: new Date("2026-11-03T16:30:00Z"),
  });
  assert.equal(result.real[0].metric_date, "2026-11-04");
});

test("live snapshot masks stale individual fields and excludes simulation by default", () => {
  const now = new Date("2026-11-04T04:00:00Z");
  const snapshot = {
    source: "sensor",
    recorded_at: now,
    device_id: 2,
    power_w: "66",
    flow_rate_lpm: "1.2",
    voltage_v: "220",
    phase_data_json: JSON.stringify({
      metric_recorded_at: {
        power_w: "2026-11-04T03:00:00Z",
        flow_rate_lpm: "2026-11-04T04:00:00Z",
      },
      ambiguous_metrics: ["voltage_v"],
    }),
  };
  const live = monitoring.presentLive(snapshot, "sensor", now);
  assert.equal(live.power_w, null);
  assert.equal(live.field_status.power_w, "stale");
  assert.equal(live.flow_rate_lpm, 1.2);
  assert.equal(live.voltage_v, null);
  assert.equal(live.field_status.voltage_v, "not_available");
  assert.equal(live.status, "live");
  const simulation = monitoring.presentLive(
    { ...snapshot, source: "simulation" },
    "sensor",
    now,
  );
  assert.equal(simulation.power_w, null);
  assert.equal(simulation.status, "no_data");
});

test("dashboard uses accessible default coop, returns null gaps and keeps simulation opt-in", async (t) => {
  t.mock.method(access, "resolveDefaultCoop", async () => ({ id: 2 }));
  t.mock.method(access, "requireCoop", async () => ({
    id: 2,
    farm_id: 1,
    timezone: "Asia/Makassar",
  }));
  t.mock.method(monitoringModel, "farm", async () => ({ id: 1 }));
  t.mock.method(monitoringModel, "live", async () => null);
  t.mock.method(monitoringModel, "devices", async () => []);
  t.mock.method(flock, "active", async () => ({ ...cycle }));
  const real = daily.buildDaily(cycle, "2026-11-03", 100, [], "real");
  const simulation = daily.buildDaily(
    cycle,
    "2026-11-03",
    100,
    [group({ source: "simulation" })],
    "simulation",
  );
  t.mock.method(daily, "recalculateCycle", async () => ({
    cycle,
    real: [real],
    simulation: [simulation],
  }));
  const actual = await monitoring.summary({ id: 1, role: "operator" }, {});
  assert.equal(actual.cycle_totals.water_liters, null);
  assert.equal(actual.live.power_w, null);
  assert.equal("simulation" in actual, false);
  const withSimulation = await monitoring.summary(
    { id: 1, role: "operator" },
    { include_simulation: true },
  );
  assert.equal(withSimulation.cycle_totals.water_liters, null);
  assert.equal(withSimulation.simulation.cycle_totals.water_liters, 20);
});

test("dashboard rejects unauthorized explicit coops before accessing telemetry", async (t) => {
  t.mock.method(access, "requireCoop", async () => {
    throw Object.assign(new Error("Forbidden"), { statusCode: 403 });
  });
  const live = t.mock.method(monitoringModel, "live", async () =>
    assert.fail("Must not read unauthorized telemetry"),
  );
  await assert.rejects(monitoring.summary({ id: 1 }, { coop_id: 99 }), {
    statusCode: 403,
  });
  assert.equal(live.mock.callCount(), 0);
});

test("dashboard empty state and query bounds require no coop-selection step", async (t) => {
  t.mock.method(access, "resolveDefaultCoop", async () => null);
  const result = await monitoring.summary({ id: 1 }, {});
  assert.equal(result.state, "no_coop");
  assert.equal(result.today, null);
  assert.equal(result.live.power_w, null);
  assert.equal(validator.summaryQuery.parse({}).include_simulation, false);
  assert.equal(
    validator.summaryQuery.safeParse({ include_simulation: "yes" }).success,
    false,
  );
  assert.equal(
    validator.chartsQuery.safeParse({
      start_date: "2025-01-01",
      end_date: "2026-11-04",
    }).success,
    false,
  );
  assert.throws(() => daily.datesBetween("2025-01-01", "2026-11-04"), {
    statusCode: 400,
  });
});
