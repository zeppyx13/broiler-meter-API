const { test } = require("node:test");
const assert = require("node:assert/strict");
const { evaluate } = require("../src/services/ecoAdvisorEngine.service");
const analytics = require("../src/services/analyticsContext.service");
const access = require("../src/services/access.service");
const model = require("../src/models/ecoAdvisor.model");
const service = require("../src/services/ecoAdvisor.service");
const schema = require("../src/validators/ecoAdvisor.validator");

function context(source = "real") {
  return {
    state: "ready",
    coop: { id: 1, farm_id: 1 },
    cycle: { id: 2, placement_date: "2026-11-01" },
    source,
    is_simulated: source === "simulation",
    local_date: "2026-11-05",
    generated_at: "2026-11-05T02:00:00Z",
    days: [],
    alerts: [],
    live: { status: "no_data" },
  };
}
function day(date, water, energy, population = 100, source = "real") {
  return {
    metric_date: date,
    flock_cycle_id: 2,
    source,
    population_basis: population,
    water_liters: water,
    energy_kwh: energy,
    data_quality: source === "simulation" ? "simulated" : "partial",
    evidence: {
      water_accepted_intervals: water == null ? 0 : 3,
      electricity_accepted_intervals: energy == null ? 0 : 3,
    },
  };
}

test("Eco returns explicit collection advice for many packets from one distinct date and never invents savings", () => {
  const ctx = context();
  ctx.days = Array.from({ length: 500 }, () => day("2026-11-04", 100, 10));
  const result = evaluate(ctx);
  assert.equal(result.state, "insufficient_data");
  assert.deepEqual(result.observed_days, { water: 1, electricity: 1 });
  assert.equal(result.required_days, 4);
  assert.equal(result.recommendations.length, 1);
  assert.equal(
    result.recommendations[0].rule_code,
    "collect_comparable_observations",
  );
  assert.equal(result.recommendations[0].estimated_savings_idr, null);
});

test("Eco comparisons use same-cycle closed dates, source, accepted evidence and positive population", () => {
  const ctx = context();
  ctx.days = [
    day("2026-11-01", 100, 10),
    day("2026-11-02", 100, 10, 100, "simulation"),
    { ...day("2026-11-03", 100, 10), flock_cycle_id: 99 },
    day("2026-11-04", null, null),
    day("2026-11-05", 99999, 99999),
    day("2026-11-06", 99999, 99999),
  ];
  assert.deepEqual(evaluate(ctx).observed_days, { water: 1, electricity: 1 });
  ctx.days = [day("2026-11-01", 0, 0, 0)];
  assert.deepEqual(evaluate(ctx).observed_days, { water: 0, electricity: 0 });
  ctx.days = [day("2026-11-01", 0, 0)];
  assert.deepEqual(evaluate(ctx).observed_days, { water: 1, electricity: 1 });
  ctx.days = [
    { ...day("2026-11-01", 100, 10), coop_id: 99 },
    {
      ...day("2026-11-02", 100, 10),
      metric_status: { water_liters: "not_available", energy_kwh: "no_data" },
    },
  ];
  assert.deepEqual(evaluate(ctx).observed_days, { water: 0, electricity: 0 });
});

test("Eco intensity comparisons normalize population and document partial sampling without diagnosing waste", () => {
  const ctx = context();
  ctx.days = [
    day("2026-11-01", 10000, 1000, 1000),
    day("2026-11-02", 4000, 400, 400),
    day("2026-11-03", 3000, 300, 300),
    day("2026-11-04", 1500, 200, 100),
  ];
  const result = evaluate(ctx);
  assert.equal(result.state, "ready");
  assert.equal(result.recommendations.length, 2);
  const water = result.recommendations.find(
    (item) => item.category === "water",
  );
  assert.equal(water.evidence_json.baseline_per_bird, 10);
  assert.equal(water.evidence_json.latest_per_bird, 15);
  assert.equal(water.evidence_json.change_percent, 50);
  assert.equal(water.evidence_json.sampling_coverage_verified, false);
  assert.match(water.description, /growth.*partial sampling.*tank buffering/i);
  assert.equal(
    result.recommendations.every((item) => item.estimated_savings_idr === null),
    true,
  );
});

test("stale comparison periods and zero baselines produce evidence guidance rather than infinite increases", () => {
  const ctx = context();
  ctx.days = [
    day("2026-11-01", 0, 0),
    day("2026-11-02", 0, 0),
    day("2026-11-03", 0, 0),
    day("2026-11-04", 100, 10),
  ];
  const result = evaluate(ctx);
  assert.equal(result.state, "insufficient_data");
  assert.equal(
    result.recommendations[0].evidence_json.metrics.water.reason,
    "nonpositive_comparison_baseline",
  );
  ctx.local_date = "2026-11-06";
  assert.equal(
    evaluate(ctx).recommendations[0].evidence_json.metrics.water.reason,
    "recent_observation_missing",
  );
});

test("Guard inspection advice requires matching provenance, unresolved state and sustained evidence", () => {
  const ctx = context("simulation");
  const base = {
    id: 5,
    alert_type: "suspected_water_anomaly",
    source: "simulation",
    status: "active",
    severity: "warning",
    detected_at: "2026-11-05T01:00:00Z",
    evidence_json: {
      reason: "sustained_configured_threshold",
      samples: 15,
      window_seconds: 60,
    },
  };
  ctx.alerts = [
    base,
    { ...base, id: 6, source: "rule" },
    { ...base, id: 7, status: "resolved" },
    { ...base, id: 8, evidence_json: {} },
    { ...base, id: 9, alert_type: "arbitrary_prompt" },
  ];
  const result = evaluate(ctx);
  const advice = result.recommendations.filter((item) =>
    item.rule_code.startsWith("inspect_guard"),
  );
  assert.equal(advice.length, 1);
  assert.equal(advice[0].evidence_json.alert_id, 5);
  assert.equal(advice[0].source, "simulation");
  assert.match(advice[0].description, /Leakage.*unconfirmed/);
  assert.equal(advice[0].estimated_savings_idr, null);
});

test("Eco material fingerprints ignore polling/heartbeat/accepted-zero-count churn but change for material trend values", () => {
  const ctx = context();
  ctx.days = [
    day("2026-11-01", 100, 10),
    day("2026-11-02", 100, 10),
    day("2026-11-03", 100, 10),
    day("2026-11-04", 200, 20),
  ];
  const first = evaluate(ctx).recommendations[0].fingerprint;
  ctx.generated_at = "2026-11-05T03:00:00Z";
  ctx.fingerprint = "changed-live-heartbeat";
  ctx.days[0].evidence.water_accepted_intervals = 500;
  assert.equal(evaluate(ctx).recommendations[0].fingerprint, first);
  ctx.days[3].water_liters = 250;
  assert.notEqual(evaluate(ctx).recommendations[0].fingerprint, first);
});

test("Eco service reuses persisted recommendations and preserves manual accepted status", async (t) => {
  const ctx = context();
  const rows = [];
  t.mock.method(analytics, "withContext", async (user, query, work) =>
    work(ctx, {}),
  );
  t.mock.method(access, "requireCoop", async () => ({ id: 1 }));
  t.mock.method(
    model,
    "findFingerprint",
    async (coopId, cycleId, source, hash) =>
      rows.find((row) => row.evidence_json.fingerprint === hash),
  );
  t.mock.method(model, "create", async (context, value) => {
    rows.push({ id: rows.length + 1, ...value, status: "new" });
    return rows.length;
  });
  t.mock.method(model, "findById", async (id) => rows[id - 1]);
  const first = await service.generate(
    { id: 1, role: "manager" },
    { source: "real" },
  );
  assert.equal(first.created_count, 1);
  rows[0].status = "accepted";
  const second = await service.generate(
    { id: 1, role: "manager" },
    { source: "real" },
  );
  assert.equal(second.created_count, 0);
  assert.equal(second.reused_count, 1);
  assert.equal(second.recommendations[0].status, "accepted");
});

test("Eco generation and manual status enforce permissions before persistence", async (t) => {
  const ctx = context();
  t.mock.method(analytics, "withContext", async (user, query, work) =>
    work(ctx, {}),
  );
  t.mock.method(access, "requireCoop", async (user, id, capability) => {
    assert.ok(["manage", "operate"].includes(capability));
    throw Object.assign(new Error("Forbidden"), { statusCode: 403 });
  });
  const insert = t.mock.method(model, "create", async () =>
    assert.fail("Unauthorized generation"),
  );
  await assert.rejects(
    service.generate({ id: 2, role: "operator" }, { source: "real" }),
    { statusCode: 403 },
  );
  t.mock.method(model, "location", async () => ({
    coop_id: 1,
    source: "rule",
  }));
  await assert.rejects(
    service.setStatus({ id: 3 }, 1, { status: "dismissed" }),
    { statusCode: 403 },
  );
  assert.equal(insert.mock.callCount(), 0);
});

test("backfill refreshes collection evidence while retaining accepted status and operator audit", async (t) => {
  const ctx = context();
  const initial = evaluate(ctx).recommendations[0];
  const interaction = {
    user_id: 1,
    status: "accepted",
    at: "2026-11-05T01:00:00Z",
  };
  const row = {
    id: 1,
    ...initial,
    status: "accepted",
    evidence_json: { ...initial.evidence_json, interaction },
  };
  ctx.days = [day("2026-11-03", 100, 10), day("2026-11-04", 100, 10)];
  t.mock.method(analytics, "withContext", async (user, query, work) =>
    work(ctx, {}),
  );
  t.mock.method(access, "requireCoop", async () => ({ id: 1 }));
  t.mock.method(model, "findFingerprint", async () => row);
  t.mock.method(model, "refreshEvidence", async (id, value) => {
    assert.deepEqual(value.observed_days, { water: 2, electricity: 2 });
    assert.deepEqual(value.interaction, interaction);
    row.evidence_json = value;
  });
  const result = await service.generate({ id: 1 }, { source: "real" });
  assert.equal(result.created_count, 0);
  assert.equal(result.recommendations[0].status, "accepted");
  assert.deepEqual(result.recommendations[0].evidence_json.observed_days, {
    water: 2,
    electricity: 2,
  });
});

test("Eco validators reject model execution, automatic actions and unsupported status/source values", () => {
  assert.equal(schema.scopeSchema.parse({}).source, "real");
  for (const payload of [
    { source: "mqtt" },
    { relay_id: 1 },
    { sql: "DELETE FROM users" },
    { email: "other@example.invalid" },
  ]) {
    assert.equal(schema.scopeSchema.safeParse(payload).success, false);
  }
  assert.equal(schema.statusSchema.safeParse({ status: "new" }).success, false);
  assert.equal(
    schema.statusSchema.safeParse({ status: "accepted", command: "off" })
      .success,
    false,
  );
  assert.equal(
    evaluate({ ...context(), state: "no_active_cycle", cycle: null })
      .recommendations.length,
    0,
  );
});
