const { test } = require("node:test");
const assert = require("node:assert/strict");
const validator = require("../src/validators/iotBroiler.validator");
const service = require("../src/services/iotBroiler.service");
const model = require("../src/models/iotBroiler.model");
const diagnostics = require("../src/utils/mqttDiagnostics");
const { createRefresher } = require("../src/services/mqttMetricsRefresh.service");

const topic = "coasther/meter/esp32_room1_water/reading";
const timestamp = "2026-11-04T23:34:40+08:00";
const reading = { coop_id: 7, flock_cycle_id: 8, recorded_at: new Date(timestamp), timezone: "Asia/Makassar" };

test("captured malformed firmware timestamps remain rejected, while valid WITA water/electric/live stay valid", () => {
  const malformed = "2000-18-10T00:130:09+08:0";
  for (const uid of ["esp32_room1_water", "esp32_room1_electric"]) {
    const message = JSON.stringify({ reading_value: 460.5, recorded_at: malformed });
    const result = validator.readingSchema.safeParse(JSON.parse(message));
    assert.equal(result.success, false);
    assert.equal(result.error.issues[0].path[0], "recorded_at");
    assert.equal(result.error.issues[0].code, "invalid_format");
    assert.equal(validator.parseMessage(`coasther/meter/${uid}/reading`, JSON.stringify({ reading_value: 460.5, recorded_at: timestamp })).kind, "meter");
  }
  const live = { room_id: 1, flow_rate_lpm: 0, water_total_liter: 460.5, voltage: 230.9,
    current: 0.1, power: 10.3, energy_kwh_total: 0.021, frequency: 50, pf: 0.97,
    recorded_at: timestamp, ntp_synced: true, wifi_ssid: "private-fixture" };
  const parsed = validator.parseMessage("coasther/telemetry/room1/live", JSON.stringify(live));
  assert.equal(parsed.kind, "telemetry");
  assert.equal("wifi_ssid" in parsed.payload, false);
  assert.equal(validator.telemetrySchema.safeParse({ ...live, recorded_at: malformed }).success, false);
});

test("plain, unescaped, truncated and binary diagnostic messages are ignored before JSON parsing", async (t) => {
  t.mock.method(model, "meterByUid", async () => assert.fail("Diagnostic must not become a reading"));
  t.mock.method(model, "deviceByTopic", async () => assert.fail("Diagnostic is nonessential"));
  const reported = t.mock.method(diagnostics, "report", () => {});
  for (const action of ["log", "control-status"]) {
    for (const payload of ["boot OK", '{"message":"quoted "text""}', '{"message":"truncated', Buffer.from([0xff, 0x00])]) {
      const result = await service.handleMessage(`coasther/device/room1/${action}`, payload, { retained: true });
      assert.equal(result.outcome, "diagnostic_ignored");
    }
  }
  assert.equal(reported.mock.callCount(), 0);
  assert.throws(() => validator.parseMessage("coasther/device/room1/log", Buffer.alloc(17000)), /payload_too_large/);
});

test("JSON, validation and transient database errors retain distinct topic/stage/reason diagnostics", async (t) => {
  const reports = [];
  t.mock.method(diagnostics, "report", (context, error) => reports.push({ context, error }));
  assert.equal((await service.handleMessage(topic, "{")).outcome, "invalid_payload");
  assert.equal(reports.at(-1).context.reason_code, "JSON_PARSE_ERROR");
  assert.equal(reports.at(-1).context.stage, "json");
  await service.handleMessage(topic, JSON.stringify({ reading_value: 1, recorded_at: "2000-18-10T00:130:09+08:0" }));
  assert.equal(reports.at(-1).context.reason_code, "VALIDATION_ERROR");
  assert.equal(reports.at(-1).context.stage, "validation");
  assert.equal(reports.at(-1).error.issues[0].path[0], "recorded_at");
  const failure = Object.assign(new Error("private-fixture SQL/password must not be echoed"), { code: "ER_LOCK_DEADLOCK" });
  t.mock.method(model, "meterByUid", async () => { throw failure; });
  assert.equal((await service.handleMessage(topic, JSON.stringify({ reading_value: 1, recorded_at: timestamp }), {
    receivedAt: new Date("2026-11-05T00:00:00Z"),
  })).outcome, "processing_error");
  assert.equal(reports.at(-1).context.stage, "mapping");
  assert.equal(reports.at(-1).context.topic, topic);
  assert.equal(reports.at(-1).error.code, "ER_LOCK_DEADLOCK");
  assert.equal(reports.at(-1).context.persisted, undefined);
});

test("metric refresh retries transient failures with bounded backoff and reports recovery", async () => {
  const events = [];
  const sleeps = [];
  let calls = 0;
  const refresher = createRefresher({
    recalculate: async () => { if (++calls < 3) throw Object.assign(new Error("private SQL details"), { code: "ER_LOCK_DEADLOCK" }); },
    sleep: async (ms) => sleeps.push(ms),
    diagnostics: { report: (context, error, level) => events.push({ context, error, level }) },
  });
  const result = await refresher.refresh(reading, { topic, persisted: true, reading_id: 1 });
  assert.deepEqual(result, { status: "refreshed", attempts: 3 });
  assert.deepEqual(sleeps, [100, 400]);
  assert.equal(events[0].context.retry_scheduled, true);
  assert.equal(events[0].context.persisted, true);
  assert.equal(events.at(-1).context.reason_code, "METRICS_REFRESH_RECOVERED");
  assert.equal(events.at(-1).level, "info");
});

test("post-commit socket failures report persisted reading rather than implying an ingestion rollback", async (t) => {
  const db = require("../src/config/db");
  const access = require("../src/services/access.service");
  const sockets = require("../src/services/broilerSocket.service");
  const calls = [];
  const reports = [];
  const connection = { async beginTransaction() {}, async commit() { calls.push("commit"); }, async rollback() { calls.push("rollback"); }, release() {} };
  t.mock.method(db, "getConnection", async () => connection);
  t.mock.method(model, "meterByUid", async () => ({ id: 13, device_id: 10, coop_id: 7 }));
  t.mock.method(access, "lockCoop", async () => ({ id: 7, farm_id: 1, status: "active" }));
  t.mock.method(model, "lockDevice", async () => ({ id: 10, coop_id: 7, is_active: 1 }));
  t.mock.method(model, "lockMeter", async () => ({ id: 13, type: "water", unit: "liter", is_active: 1 }));
  t.mock.method(model, "farmContext", async () => ({ is_active: 1, timezone: "Asia/Makassar" }));
  t.mock.method(model, "duplicate", async () => null);
  t.mock.method(model, "cursor", async () => null);
  t.mock.method(model, "cycles", async () => []);
  t.mock.method(model, "timestampConflict", async () => false);
  t.mock.method(model, "insertReading", async () => 555);
  t.mock.method(model, "updateCursor", async () => {});
  t.mock.method(sockets, "publish", async () => { throw new Error("Injected private socket error"); });
  t.mock.method(diagnostics, "report", (context) => reports.push(context));
  const result = await service.handleMessage(topic, JSON.stringify({ reading_value: 1, recorded_at: timestamp }), {
    heartbeat: false, io: {}, receivedAt: new Date("2026-11-05T00:00:00Z"),
  });
  assert.equal(result.outcome, "processing_error");
  assert.deepEqual(calls, ["commit"]);
  assert.equal(reports[0].stage, "socket_emit");
  assert.equal(reports[0].reason_code, "SOCKET_EMIT_FAILED");
  assert.equal(reports[0].persisted, true);
  assert.equal(reports[0].reading_id, 555);
});

test("permanent and exhausted refresh errors are surfaced without infinite retry and next delivery can repair", async () => {
  for (const code of ["ER_BAD_FIELD_ERROR", "ER_LOCK_DEADLOCK"]) {
    let calls = 0;
    let failing = true;
    const events = [];
    const refresher = createRefresher({
      recalculate: async () => { calls++; if (failing) throw Object.assign(new Error("private details"), { code }); },
      sleep: async () => {},
      diagnostics: { report: (context, error, level) => events.push({ context, level }) },
    });
    const failed = await refresher.refresh(reading);
    assert.equal(failed.status, "failed");
    assert.equal(calls, code === "ER_LOCK_DEADLOCK" ? 3 : 1);
    assert.equal(events.at(-1).context.retry_scheduled, false);
    assert.equal(events.at(-1).context.reason_code, "METRICS_RETRY_EXHAUSTED");
    assert.equal(events.at(-1).level, "error");
    failing = false;
    assert.equal((await refresher.refresh(reading)).status, "refreshed");
  }
});

test("in-flight same-day refreshes coalesce and recalculate after a newer reading commits", async () => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const observed = [];
  const refresher = createRefresher({
    recalculate: async (value) => { observed.push(value.recorded_at.toISOString()); if (observed.length === 1) await blocked; },
    diagnostics: { report() {} },
  });
  const first = refresher.refresh(reading);
  const second = refresher.refresh({ ...reading, recorded_at: new Date("2026-11-04T15:35:00Z") });
  assert.equal(first, second);
  release();
  assert.equal((await first).status, "refreshed");
  assert.deepEqual(observed, [new Date(timestamp).toISOString(), "2026-11-04T15:35:00.000Z"]);
});

test("refresh coalescing respects different farm-local dates inside a single UTC day", async () => {
  const observed = [];
  const refresher = createRefresher({ recalculate: async (value) => observed.push(value.recorded_at.toISOString()), diagnostics: { report() {} } });
  await Promise.all([
    refresher.refresh({ ...reading, recorded_at: new Date("2026-11-04T15:59:59Z") }),
    refresher.refresh({ ...reading, recorded_at: new Date("2026-11-04T16:00:00Z") }),
  ]);
  assert.equal(observed.length, 2);
});

test("a refresh arriving as the previous calculation completes cannot reuse an already completed job", async () => {
  let finish;
  const calculated = new Promise((resolve) => { finish = resolve; });
  const calls = [];
  const refresher = createRefresher({
    recalculate: (value) => { calls.push(value.id); return calls.length === 1 ? calculated : Promise.resolve(); },
    diagnostics: { report() {} },
  });
  const first = refresher.refresh({ ...reading, id: 1 });
  let second;
  calculated.then(() => { second = refresher.refresh({ ...reading, id: 2 }); });
  finish();
  await first;
  await second;
  assert.deepEqual(calls, [1, 2]);
});
