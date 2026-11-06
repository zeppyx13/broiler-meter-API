const { test } = require("node:test");
const assert = require("node:assert/strict");
const { project } = require("../src/services/forecastEngine.service");
const schema = require("../src/validators/forecast.validator");
const analytics = require("../src/services/analyticsContext.service");
const access = require("../src/services/access.service");
const model = require("../src/models/forecast.model");
const service = require("../src/services/forecast.service");

function day(date, water = 100, energy = 5, population = 100, extra = {}) {
  return {
    coop_id: 1,
    flock_cycle_id: 2,
    metric_date: date,
    source: "real",
    data_quality: "partial",
    population_basis: population,
    water_liters: water,
    energy_kwh: energy,
    metric_status: { water_liters: "partial", energy_kwh: "partial" },
    evidence: {
      water_accepted_intervals: 2,
      electricity_accepted_intervals: 2,
    },
    ...extra,
  };
}
function context(extra = {}) {
  return {
    state: "ready",
    coop: { id: 1, farm_id: 3 },
    farm: { electricity_rate_idr_per_kwh: 1000, water_rate_idr_per_m3: 2000 },
    cycle: {
      id: 2,
      coop_id: 1,
      status: "active",
      placement_date: "2026-11-01",
      planned_harvest_date: "2026-11-08",
      current_population: 60,
      initial_population: 100,
    },
    local_date: "2026-11-05",
    day_age: 5,
    source: "real",
    generated_at: "2026-11-05T04:00:00.000Z",
    days: [
      day("2026-11-02", 100, 5, 100),
      day("2026-11-03", 180, 9, 90),
      day("2026-11-04", 160, 8, 80),
    ],
    ...extra,
  };
}
const value = (output, metric, horizon = "next_day") =>
  output.forecasts.find(
    (item) => item.metric === metric && item.horizon === horizon,
  )?.predicted_value;

test("per-bird moving average projects tomorrow and future harvest dates with correct units/tariffs", () => {
  const result = project(context());
  assert.equal(result.state, "low_confidence");
  assert.equal(result.forecasts.length, 6);
  assert.equal(value(result, "water_liters"), 100);
  assert.equal(value(result, "energy_kwh"), 5);
  assert.equal(value(result, "electricity_cost_idr"), 5000);
  assert.equal(value(result, "water_liters", "until_harvest"), 300);
  assert.equal(value(result, "energy_kwh", "until_harvest"), 15);
  const water = result.forecasts.find(
    (item) =>
      item.metric === "water_liters" && item.horizon === "until_harvest",
  );
  assert.equal(water.details_json.estimated_water_cost_idr, 600);
  assert.equal(water.target_date, "2026-11-08");
  assert.equal(water.input_days, 3);
  assert.equal(result.horizons.next_day.target_date, "2026-11-06");
  assert.equal(result.remaining_days, 3);
  assert.ok(result.forecasts.every((item) => item.confidence === "low"));
});

test("500 messages from a single date remain one observed day, not sufficient history", () => {
  const result = project(
    context({ days: Array.from({ length: 500 }, () => day("2026-11-04")) }),
  );
  assert.equal(result.observed_days.water_liters, 1);
  assert.equal(result.eligible_days.water_liters, 1);
  assert.equal(result.state, "insufficient_data");
  assert.equal(result.forecasts.length, 0);
});

test("current local day is observed but excluded from training; missing metrics stay unavailable", () => {
  const days = [
    day("2026-11-03"),
    day("2026-11-04"),
    day("2026-11-05", 1, 0.1),
  ];
  const result = project(context({ days }));
  assert.equal(result.observed_days.water_liters, 3);
  assert.equal(result.eligible_days.water_liters, 2);
  assert.equal(result.state, "insufficient_data");
  const waterOnly = project(
    context({
      days: context().days.map((row) => ({ ...row, energy_kwh: null })),
    }),
  );
  assert.equal(value(waterOnly, "water_liters"), 100);
  assert.equal(value(waterOnly, "energy_kwh"), undefined);
});

test("accepted measured zero differs from cache zero without evidence, and zero population is never divided", () => {
  const days = ["2026-11-02", "2026-11-03", "2026-11-04"].map((date) =>
    day(date, 0, 0),
  );
  assert.equal(value(project(context({ days })), "water_liters"), 0);
  assert.equal(
    project(
      context({
        days: days.map((row) => ({
          ...row,
          evidence: {
            water_accepted_intervals: 0,
            electricity_accepted_intervals: 0,
          },
        })),
      }),
    ).forecasts.length,
    0,
  );
  const zero = context();
  zero.cycle.current_population = 0;
  assert.equal(project(zero).forecasts.length, 0);
  assert.equal(
    project(zero).metrics.water_liters.reason,
    "current_population_not_positive",
  );
});

test("simulation, another cycle, ambiguous metrics and future calendar dates cannot fill real history", () => {
  const days = context().days.map((row) => ({
    ...row,
    source: "simulation",
    data_quality: "simulated",
  }));
  assert.equal(project(context({ days })).forecasts.length, 0);
  const simulation = project(context({ days, source: "simulation" }));
  assert.equal(simulation.is_simulated, true);
  assert.equal(value(simulation, "water_liters"), 100);
  assert.equal(
    project(
      context({
        days: context().days.map((row) => ({ ...row, flock_cycle_id: 999 })),
      }),
    ).forecasts.length,
    0,
  );
  assert.equal(
    project(
      context({
        days: [...context().days.slice(0, 2), day("2026-11-06", 99999, 99999)],
      }),
    ).forecasts.length,
    0,
  );
  assert.equal(
    value(
      project(
        context({
          days: context().days.map((row) => ({
            ...row,
            metric_status: { water_liters: "not_available" },
          })),
        }),
      ),
      "water_liters",
    ),
    undefined,
  );
});

test("harvest day counts exclude today; invalid long/missing/past harvest does not disable tomorrow", () => {
  for (const planned of [null, "2027-06-11", "2026-11-04", "invalid"]) {
    const input = context();
    input.cycle.planned_harvest_date = planned;
    const result = project(input);
    assert.equal(
      result.horizons.until_harvest.state,
      "invalid_harvest_horizon",
    );
    assert.equal(value(result, "water_liters"), 100);
    assert.equal(value(result, "water_liters", "until_harvest"), undefined);
  }
  const today = context();
  today.cycle.planned_harvest_date = today.local_date;
  assert.equal(
    project(today).horizons.until_harvest.state,
    "no_remaining_future_days",
  );
  const tomorrow = context();
  tomorrow.cycle.planned_harvest_date = "2026-11-06";
  assert.equal(value(project(tomorrow), "water_liters", "until_harvest"), 100);
});

test("stale historical days are reported rather than projected as fresh data", () => {
  const input = context({
    days: [day("2026-11-01"), day("2026-11-02"), day("2026-11-03")],
  });
  const result = project(input, { max_data_age_days: 1 });
  assert.equal(result.eligible_days.water_liters, 3);
  assert.equal(result.forecasts.length, 0);
  assert.equal(result.metrics.water_liters.reason, "stale_history");
});

test("material forecast fingerprint ignores live/Guard/today polling changes but changes with population, tariff or backfill", () => {
  const first = project(context());
  const updated = context({
    generated_at: "2026-11-05T04:01:00Z",
    live: { power_w: 50 },
    alerts: [{ id: 99 }],
    days: [...context().days, day("2026-11-05", 100000, 999)],
  });
  assert.equal(project(updated).input_fingerprint, first.input_fingerprint);
  assert.equal(project(updated).observed_days.water_liters, 4);
  const repeatedMessages = context();
  repeatedMessages.days[0].evidence.water_accepted_intervals += 500;
  assert.equal(
    project(repeatedMessages).input_fingerprint,
    first.input_fingerprint,
  );
  for (const mutate of [
    (ctx) => {
      ctx.cycle.current_population = 50;
    },
    (ctx) => {
      ctx.farm.electricity_rate_idr_per_kwh = 1500;
    },
    (ctx) => {
      ctx.days[0].water_liters = 110;
    },
  ]) {
    const input = context();
    mutate(input);
    assert.notEqual(project(input).input_fingerprint, first.input_fingerprint);
  }
});

test("unrepresentable currency projection is unavailable instead of overflowing the SQL column", () => {
  const input = context();
  input.farm.electricity_rate_idr_per_kwh = 9999999999;
  input.days = input.days.map((row) => ({ ...row, energy_kwh: 1000000000 }));
  const output = project(input);
  assert.ok(output.forecasts.some((row) => row.metric === "energy_kwh"));
  assert.equal(
    output.forecasts.some((row) => row.metric === "electricity_cost_idr"),
    false,
  );
  assert.equal(
    output.metrics.electricity_cost_idr.reason,
    "projection_exceeds_storage_range",
  );
});

test("forecast routes validate schema enums, provenance, bounded windows and reject arbitrary input", () => {
  assert.equal(schema.querySchema.parse({}).source, "real");
  assert.equal(
    schema.querySchema.safeParse({ window_days: "2" }).success,
    false,
  );
  assert.equal(
    schema.generateSchema.safeParse({ source: "mqtt" }).success,
    false,
  );
  assert.equal(
    schema.generateSchema.safeParse({ relay: "off" }).success,
    false,
  );
  assert.equal(
    schema.historySchema.safeParse({ horizon: "next_7_days" }).success,
    false,
  );
});

test("same material inputs reuse IDs, while new evidence appends predictions and refreshes observed-day metadata", async (t) => {
  let input = context();
  const saved = new Map();
  let inserts = 0;
  t.mock.method(analytics, "withContext", async (user, query, work) =>
    work(input, {}),
  );
  t.mock.method(model, "cache", async (key) => saved.get(key) || null);
  t.mock.method(model, "create", async () => ++inserts);
  t.mock.method(model, "saveCache", async (ctx, key, value) =>
    saved.set(key, {
      result_json: JSON.stringify(value),
      expires_at: "2026-11-07T04:00:00Z",
    }),
  );
  const first = await service.current(
    { id: 1 },
    { source: "real", window_days: 7 },
  );
  input = {
    ...input,
    generated_at: "2026-11-05T04:01:00Z",
    days: [...input.days, day("2026-11-05")],
  };
  const again = await service.current(
    { id: 1 },
    { source: "real", window_days: 7 },
  );
  assert.equal(inserts, 6);
  assert.deepEqual(
    again.forecasts.map((row) => row.id),
    first.forecasts.map((row) => row.id),
  );
  assert.equal(again.cache_status, "reused_same_inputs");
  assert.equal(again.observed_days.water_liters, 4);
  input.days[0] = { ...input.days[0], water_liters: 110 };
  await service.current({ id: 1 }, { source: "real", window_days: 7 });
  assert.equal(inserts, 12);
});

test("generation requires manage permission and insufficient data persists no forecast rows", async (t) => {
  const input = context({ days: [day("2026-11-04")] });
  t.mock.method(analytics, "withContext", async (user, query, work) =>
    work(input, {}),
  );
  t.mock.method(access, "requireCoop", async () => {
    throw Object.assign(new Error("Forbidden"), { statusCode: 403 });
  });
  const create = t.mock.method(model, "create", async () =>
    assert.fail("No numeric forecast is justified"),
  );
  t.mock.method(model, "cache", async () => null);
  t.mock.method(model, "saveCache", async () => {});
  await assert.rejects(service.generate({ id: 1 }, {}), { statusCode: 403 });
  const result = await service.current({ id: 1 }, {});
  assert.equal(result.state, "insufficient_data");
  assert.equal(create.mock.callCount(), 0);
});
