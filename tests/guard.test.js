const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createEngine } = require("../src/services/guardEngine.service");
const schema = require("../src/validators/guard.validator");

const start = Date.parse("2026-11-05T04:00:00Z");
const rule = (rule_code, parameters_json, extra = {}) => ({
  id: 1,
  ...schema.createSchema.parse({
    coop_id: 1,
    rule_code,
    name: "Deterministic test rule",
    parameters_json,
    evaluation_window_sec: 10,
    ...extra,
  }),
});
function context(
  seconds,
  {
    power = 5,
    flow = 0,
    voltage = 220,
    source = "sensor",
    at,
    deviceId = 1,
  } = {},
) {
  const now = new Date(start + seconds * 1000);
  const recorded = at || now.toISOString();
  return {
    coopId: 1,
    now,
    source: source === "simulation" ? "simulation" : "rule",
    devices: [{ id: deviceId, is_active: 1, last_seen_at: now }],
    snapshot: {
      device_id: deviceId,
      source,
      recorded_at: recorded,
      power_w: power,
      voltage_v: voltage,
      flow_rate_lpm: flow,
      phase_data_json: JSON.stringify({
        metric_recorded_at: {
          power_w: recorded,
          voltage_v: recorded,
          flow_rate_lpm: recorded,
        },
        metric_device_id: {
          power_w: deviceId,
          voltage_v: deviceId,
          flow_rate_lpm: deviceId,
        },
      }),
    },
  };
}

test("Guard schema validates per-rule thresholds, severity, JSON keys and no-flow expectation", () => {
  assert.equal(
    schema.createSchema.safeParse({
      coop_id: 1,
      rule_code: "device_offline",
      name: "Offline",
      parameters_json: {},
    }).success,
    true,
  );
  assert.equal(
    schema.createSchema.safeParse({
      coop_id: 1,
      rule_code: "device_offline",
      name: "Offline",
      severity: "critical",
      evaluation_window_sec: 120,
      parameters_json: {},
    }).success,
    false,
  );
  assert.equal(
    schema.createSchema.safeParse({
      coop_id: 1,
      rule_code: "device_offline",
      name: "Offline",
      parameters_json: { sql: "arbitrary" },
    }).success,
    false,
  );
  assert.throws(() =>
    rule("suspected_power_anomaly", { min_power_w: 20, recovery_power_w: 10 }),
  );
  assert.throws(() =>
    rule("suspected_water_anomaly", { max_flow_lpm: 5, recovery_flow_lpm: 10 }),
  );
  assert.equal(rule("no_water_flow", {}).is_active, false);
  assert.throws(() => rule("no_water_flow", {}, { is_active: true }));
  assert.throws(() =>
    rule(
      "suspected_power_anomaly",
      { min_power_w: 10, recovery_power_w: 15 },
      { severity: "critical" },
    ),
  );
});

test("power anomaly requires a full distinct-sample window and resolves only after sustained recovery", () => {
  const engine = createEngine();
  const power = rule("suspected_power_anomaly", {
    min_power_w: 10,
    recovery_power_w: 15,
    recovery_window_sec: 10,
  });
  assert.equal(
    engine.evaluateRule(power, context(0))[0].status,
    "insufficient_data",
  );
  assert.equal(
    engine.evaluateRule(power, context(5))[0].status,
    "insufficient_data",
  );
  assert.equal(engine.evaluateRule(power, context(10))[0].status, "trigger");
  assert.equal(
    engine.evaluateRule(power, context(15, { power: 12 }))[0].status,
    "normal",
  );
  assert.notEqual(
    engine.evaluateRule(power, context(20, { power: 20 }))[0].status,
    "recovery",
  );
  engine.evaluateRule(power, context(25, { power: 20 }));
  assert.equal(
    engine.evaluateRule(power, context(30, { power: 20 }))[0].status,
    "recovery",
  );
  assert.equal(
    createEngine().evaluateRule(power, context(30))[0].status,
    "insufficient_data",
    "Restart cannot fabricate power history",
  );
});

test("null/stale/ambiguous/zero-panel measurements never become a physical-fault alert", () => {
  const power = rule("suspected_power_anomaly", {
    min_power_w: 10,
    recovery_power_w: 15,
  });
  for (const overrides of [
    { power: null },
    { power: 0 },
    { voltage: 0 },
    { at: "2026-11-05T03:00:00Z" },
  ]) {
    const engine = createEngine();
    for (const seconds of [0, 5, 10, 15])
      assert.equal(
        engine.evaluateRule(power, context(seconds, overrides))[0].status,
        "insufficient_data",
      );
  }
  const ambiguous = context(10);
  ambiguous.snapshot.phase_data_json = JSON.stringify({
    ambiguous_metrics: ["power_w"],
  });
  assert.equal(
    createEngine().evaluateRule(power, ambiguous)[0].reason,
    "ambiguous_metric",
  );
});

test("simulation and real observation windows are isolated and duplicate snapshots cannot warm history", () => {
  const engine = createEngine();
  const power = rule("suspected_power_anomaly", {
    min_power_w: 10,
    recovery_power_w: 15,
  });
  for (const seconds of [0, 5, 10])
    engine.evaluateRule(power, context(seconds, { source: "simulation" }));
  const real = context(10, { source: "simulation" });
  real.source = "rule";
  assert.equal(engine.evaluateRule(power, real)[0].status, "insufficient_data");
  const fresh = createEngine();
  for (const seconds of [0, 5, 10])
    assert.notEqual(
      fresh.evaluateRule(
        power,
        context(seconds, { at: new Date(start).toISOString() }),
      )[0].status,
      "trigger",
    );
});

test("normal intermittent tank filling does not trigger a sustained high-flow indication", () => {
  const engine = createEngine();
  const water = rule("suspected_water_anomaly", {
    max_flow_lpm: 8,
    recovery_flow_lpm: 3,
    recovery_window_sec: 10,
  });
  for (const [seconds, flow] of [
    [0, 10],
    [5, 0],
    [10, 10],
    [15, 0],
    [20, 10],
  ]) {
    assert.notEqual(
      engine.evaluateRule(water, context(seconds, { flow }))[0].status,
      "trigger",
    );
  }
  engine.evaluateRule(water, context(25, { flow: 10 }));
  const decision = engine.evaluateRule(water, context(30, { flow: 10 }))[0];
  assert.equal(decision.status, "trigger");
  assert.match(decision.evidence.interpretation, /leakage is not confirmed/i);
});

test("no-flow requires bounded explicit expectation and expiry stops evaluation", () => {
  const engine = createEngine();
  const noFlow = rule(
    "no_water_flow",
    {
      expected_flow: true,
      expected_flow_until: new Date(start + 20000).toISOString(),
      context_note: "Operator expects inlet filling",
    },
    { is_active: true },
  );
  engine.evaluateRule(noFlow, context(0));
  engine.evaluateRule(noFlow, context(5));
  assert.equal(engine.evaluateRule(noFlow, context(10))[0].status, "trigger");
  assert.equal(
    engine.evaluateRule(noFlow, context(20))[0].status,
    "insufficient_evidence",
  );
  assert.equal(
    engine.evaluateRule(rule("no_water_flow", {}), context(10))[0].status,
    "not_evaluated",
  );
});

test("offline watchdog uses trusted last_seen elapsed time and sustained reconnect recovery", () => {
  const engine = createEngine();
  const offline = rule("device_offline", {
    stale_after_seconds: 30,
    recovery_window_sec: 10,
  });
  const evaluate = (seconds, last_seen_at) =>
    engine.evaluateRule(offline, {
      coopId: 1,
      now: new Date(start + seconds * 1000),
      source: "rule",
      devices: [{ id: 1, is_active: 1, last_seen_at }],
      snapshot: null,
    })[0];
  assert.equal(evaluate(100, null).status, "insufficient_data");
  assert.equal(evaluate(39, new Date(start)).status, "normal");
  assert.equal(evaluate(40, new Date(start)).status, "trigger");
  assert.equal(evaluate(50, new Date(start + 50000)).status, "normal");
  assert.equal(evaluate(60, new Date(start + 60000)).status, "recovery");
  const rtcInvalid = engine.evaluateRule(offline, {
    coopId: 1,
    now: new Date(start + 200000),
    source: "rule",
    snapshot: null,
    devices: [
      {
        id: 1,
        is_active: 1,
        last_seen_at: new Date(start),
        last_invalid_timestamp_at: new Date(start + 195000),
      },
    ],
  })[0];
  assert.equal(rtcInvalid.status, "insufficient_data");
  assert.equal(rtcInvalid.reason, "invalid_timestamp_received");
});

test("observation gaps and rule-specific validity cannot fabricate or poison another rule's window", () => {
  const engine = createEngine();
  const water = rule("suspected_water_anomaly", {
    max_flow_lpm: 8,
    recovery_flow_lpm: 3,
    max_sample_gap_sec: 5,
  });
  engine.evaluateRule(water, context(0, { flow: 10 }));
  engine.evaluateRule(water, context(5, { flow: 10 }));
  assert.equal(
    engine.evaluateRule(water, context(20, { flow: 10 }))[0].status,
    "insufficient_data",
  );
  const strict = rule("suspected_power_anomaly", {
    min_power_w: 10,
    recovery_power_w: 15,
    min_voltage_v: 250,
  });
  const permissive = {
    ...rule("suspected_power_anomaly", {
      min_power_w: 10,
      recovery_power_w: 15,
    }),
    id: 2,
  };
  for (const seconds of [0, 5, 10]) {
    engine.evaluateRule(strict, context(seconds));
    const decision = engine.evaluateRule(permissive, context(seconds))[0];
    if (seconds === 10) assert.equal(decision.status, "trigger");
  }
});

test("history has bounded keys and samples", () => {
  const engine = createEngine({ maxKeys: 2, maxSamples: 3 });
  const power = rule("suspected_power_anomaly", {
    min_power_w: 10,
    recovery_power_w: 15,
  });
  for (let id = 1; id <= 4; id++)
    for (let seconds = 0; seconds < 6; seconds++)
      engine.evaluateRule({ ...power, id }, context(seconds));
  assert.ok(engine.historyStats().keys <= 2);
  assert.ok(engine.historyStats().samples <= 6);
});
