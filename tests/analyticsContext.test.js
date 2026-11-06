const { test } = require("node:test");
const assert = require("node:assert/strict");
const service = require("../src/services/analyticsContext.service");
const model = require("../src/models/analyticsContext.model");
const parents = require("../src/models/access.model");
const daily = require("../src/models/dailyMetrics.model");
const access = require("../src/services/access.service");
const db = require("../src/config/db");

function setup(t) {
  const calls = [];
  const connection = {
    beginTransaction: async () => calls.push("begin"),
    commit: async () => calls.push("commit"),
    rollback: async () => calls.push("rollback"),
    release: () => calls.push("release"),
  };
  const now = new Date("2026-11-04T16:10:00Z");
  const cycle = {
    id: 8,
    coop_id: 7,
    cycle_code: "fixture",
    placement_date: "2026-11-03",
    planned_harvest_date: "2026-12-07",
    initial_population: 100,
    current_population: 90,
    status: "active",
  };
  t.mock.method(db, "getConnection", async () => connection);
  t.mock.method(model, "coopLocation", async () => {
    calls.push("routing");
    return { farm_id: 6 };
  });
  t.mock.method(parents, "lockFarm", async () => calls.push("farm"));
  t.mock.method(parents, "lockCoop", async () => calls.push("coop"));
  t.mock.method(access, "requireCoop", async () => {
    calls.push("authorize");
    return {
      id: 7,
      farm_id: 6,
      code: "F",
      name: "Fixture",
      status: "active",
      owner_user_id: 999,
    };
  });
  t.mock.method(model, "farm", async () => ({
    id: 6,
    name: "Fixture farm",
    timezone: "Asia/Makassar",
    is_active: 1,
    electricity_rate_idr_per_kwh: "1000.00",
    water_rate_idr_per_m3: "2000.00",
  }));
  t.mock.method(model, "activeCycle", async () => {
    calls.push("cycle");
    return cycle;
  });
  t.mock.method(model, "live", async () => null);
  t.mock.method(model, "devices", async () => [
    {
      id: 10,
      name: "Fixture",
      is_active: 1,
      last_seen_at: null,
      device_uid: "private",
      mqtt_topic_key: "private",
      token: "private",
    },
  ]);
  t.mock.method(model, "alerts", async () => []);
  t.mock.method(daily, "populationChanges", async (_, date) =>
    date === "2026-11-03" ? 0 : -10,
  );
  t.mock.method(
    daily,
    "dayReadings",
    async (_coop, _cycle, start, end, conn) => {
      assert.equal(conn, connection);
      assert.ok(end.getTime() <= now.getTime() + 1);
      assert.ok(end > start);
      calls.push(["day", start.toISOString(), end.toISOString()]);
      return [
        {
          meter_id: 13,
          device_id: 10,
          type: "water",
          channel: "main",
          source: "mqtt",
          reading_count: 2,
          accepted_count: 1,
          consumption: "10.000000",
          last_accepted_at: start,
        },
        {
          meter_id: 13,
          device_id: 10,
          type: "water",
          channel: "main",
          source: "simulation",
          reading_count: 2,
          accepted_count: 1,
          consumption: "99.000000",
          last_accepted_at: start,
        },
        {
          meter_id: 14,
          device_id: 10,
          type: "electricity",
          channel: "main",
          source: "mqtt",
          reading_count: 1,
          accepted_count: 0,
          consumption: "0.000000",
          last_accepted_at: null,
        },
      ];
    },
  );
  return { calls, connection, now, cycle };
}

test("analytics locks canonical parents before cycle/evidence reads and caps today's evidence at the requested instant", async (t) => {
  const { calls, now, connection } = setup(t);
  const data = await service.withContext(
    { id: 1, role: "manager" },
    { coop_id: 7, now },
    async (context, conn) => {
      assert.equal(conn, connection);
      return context;
    },
  );
  assert.deepEqual(calls.slice(0, 6), [
    "routing",
    "begin",
    "farm",
    "coop",
    "authorize",
    "cycle",
  ]);
  assert.deepEqual(calls.slice(-2), ["commit", "release"]);
  assert.equal(data.local_date, "2026-11-05");
  assert.equal(data.day_age, 3);
  assert.equal(data.days.length, 3);
  assert.equal(data.days[0].water_liters, 10);
  assert.equal(data.days[1].population_basis, 90);
  assert.equal(data.days[0].energy_kwh, null); // A baseline row is not measured zero energy.
  assert.equal(data.cycle_totals.water_liters, 30);
  assert.equal(data.cycle_totals.energy_kwh, null);
  assert.equal(data.today.metric_date, "2026-11-05");
  assert.equal(data.days[0].source, "real");
  assert.equal(JSON.stringify(data).includes("private"), false);
  assert.equal("owner_user_id" in data.coop, false);
});

test("simulation analytics never fill real gaps and no daily cache writes are performed", async (t) => {
  const { now } = setup(t);
  const writes = t.mock.method(daily, "upsert", async () =>
    assert.fail("Advisory context cannot overwrite the daily cache"),
  );
  const data = await service.load(
    { id: 1, role: "operator" },
    { coop_id: 7, source: "simulation", now },
  );
  assert.equal(data.source, "simulation");
  assert.equal(data.is_simulated, true);
  assert.equal(data.days[0].water_liters, 99);
  assert.equal(data.days[0].energy_kwh, null);
  assert.equal(data.days[0].data_quality, "simulated");
  assert.equal(writes.mock.callCount(), 0);
});

test("advisory default resolution is read-only and empty state needs no database transaction", async (t) => {
  t.mock.method(parents, "findDefaultCoop", async () => null);
  t.mock.method(parents, "firstAccessibleCoop", async () => null);
  t.mock.method(parents, "setDefaultCoop", async () =>
    assert.fail("Analytics reads must not rewrite a profile"),
  );
  t.mock.method(db, "getConnection", async () =>
    assert.fail("No coop requires no transaction"),
  );
  const result = await service.load({ id: 1, role: "operator" });
  assert.equal(result.state, "no_coop");
  assert.deepEqual(result.days, []);
});

test("denied coop access stops all analytics reads and rolls back the transaction", async (t) => {
  const { calls, now } = setup(t);
  t.mock.method(access, "requireCoop", async () => {
    throw Object.assign(new Error("Forbidden"), { statusCode: 403 });
  });
  const read = t.mock.method(model, "activeCycle", async () =>
    assert.fail("Private cycle cannot be read"),
  );
  await assert.rejects(
    service.load({ id: 1, role: "operator" }, { coop_id: 7, now }),
    { statusCode: 403 },
  );
  assert.equal(read.mock.callCount(), 0);
  assert.deepEqual(calls.slice(-2), ["rollback", "release"]);
});

test("Guard evidence projection excludes private notes and arbitrary nested instruction fields", () => {
  const evidence = service.alertEvidence(
    JSON.stringify({
      threshold: 50,
      window_seconds: 120,
      samples: 20,
      reason: "sustained_configured_threshold",
      evaluation: "trigger",
      metric: "power_w",
      context_note: "private",
      resolution: { user_id: 900, note: "private" },
      latest_evaluation: { threshold: 50, command_token: "private" },
    }),
  );
  assert.equal(evidence.threshold, 50);
  assert.equal(evidence.reason, "sustained_configured_threshold");
  assert.equal(evidence.latest_evaluation.threshold, 50);
  assert.equal(JSON.stringify(evidence).includes("private"), false);
  assert.equal("resolution" in evidence, false);
});

test("analytics revisions ignore generation time but change with measurement, cycle, tariff and provenance", () => {
  const first = {
    source: "real",
    cycle: { id: 8 },
    farm: { electricity_rate_idr_per_kwh: 1000 },
    days: [{ energy_kwh: 1 }],
    generated_at: "one",
  };
  const revision = service.fingerprint(first);
  assert.equal(
    service.fingerprint({ ...first, generated_at: "two" }),
    revision,
  );
  for (const change of [
    { source: "simulation" },
    { cycle: { id: 9 } },
    { days: [{ energy_kwh: 2 }] },
    { farm: { electricity_rate_idr_per_kwh: 2000 } },
  ])
    assert.notEqual(service.fingerprint({ ...first, ...change }), revision);
});

test("Broiler HTTP failures never log SQL or private Copilot messages and repeated failures are bounded", (t) => {
  const handler = require("../src/middlewares/error.middleware");
  const logger = require("../src/config/logger");
  const oldEnv = { mode: process.env.NODE_ENV, database: process.env.DB_NAME };
  const logged = [];
  const failures = t.mock.method(logger, "error", (entry) =>
    logged.push(entry),
  );
  const raw = t.mock.method(console, "error", () =>
    assert.fail("Raw SQL errors must not reach logs"),
  );
  process.env.NODE_ENV = "development";
  process.env.DB_NAME = "coasther_broiler";
  const response = {
    status(code) {
      this.code = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
  const error = Object.assign(new Error("private-copilot-prompt"), {
    code: "ER_DATA_TOO_LONG",
    sql: "INSERT ai_messages VALUES ('private-copilot-prompt')",
    sqlMessage: "private-copilot-prompt",
  });
  try {
    handler(error, {}, response, () => {});
    handler(error, {}, response, () => {});
    assert.equal(response.code, 500);
    assert.equal(response.body.message, "Internal server error");
    assert.equal(failures.mock.callCount(), 1);
    assert.equal(raw.mock.callCount(), 0);
    assert.equal(
      JSON.stringify(logged).includes("private-copilot-prompt"),
      false,
    );
    assert.equal(JSON.parse(logged[0]).error_code, "ER_DATA_TOO_LONG");
  } finally {
    oldEnv.mode === undefined
      ? delete process.env.NODE_ENV
      : (process.env.NODE_ENV = oldEnv.mode);
    oldEnv.database === undefined
      ? delete process.env.DB_NAME
      : (process.env.DB_NAME = oldEnv.database);
  }
});
