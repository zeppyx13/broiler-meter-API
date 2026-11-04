const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const validator = require("../src/validators/iotBroiler.validator");
const { classify } = require("../src/utils/meterCounter");
const service = require("../src/services/iotBroiler.service");
const model = require("../src/models/iotBroiler.model");
const access = require("../src/services/access.service");
const db = require("../src/config/db");

const message = (value, date) =>
  JSON.stringify({ reading_value: value, recorded_at: date });
test("firmware payload parsing strips private fields and normalizes WITA to UTC database seconds", () => {
  const parsed = validator.parseMessage(
    "coasther/meter/esp32.room:1_water/reading",
    message(12.3456789, "2026-11-04T10:30:00.123+08:00"),
  );
  assert.equal(
    parsed.payload.recorded_at.toISOString(),
    "2026-11-04T02:30:00.000Z",
  );
  assert.equal(parsed.payload.reading_value, 12.345679);
  const telemetry = validator.parseMessage(
    "coasther/telemetry/room1/live",
    JSON.stringify({
      room_id: 999,
      voltage: 220,
      power: 66,
      recorded_at: "2026-11-04T10:30:00+08:00",
      wifi_ssid: "private",
      relay_cutoff: true,
    }),
  );
  assert.equal(telemetry.payload.voltage, 220);
  assert.equal("wifi_ssid" in telemetry.payload, false);
  assert.equal("room_id" in telemetry.payload, false);
  assert.equal(telemetry.payload.relay_cutoff, true);
});

test("MQTT parser rejects invalid types, bounds, naive timestamps and oversized payloads", () => {
  for (const payload of [
    message(-1, "2026-11-04T10:30:00+08:00"),
    message("1", "2026-11-04T10:30:00+08:00"),
    message(1, "2026-11-04T10:30:00"),
    "null",
    "{",
  ]) {
    assert.throws(() =>
      validator.parseMessage("coasther/meter/uid/reading", payload),
    );
  }
  assert.throws(() =>
    validator.parseMessage("coasther/meter/uid/reading", Buffer.alloc(17000)),
  );
  assert.equal(
    validator.parseMessage("coasther/device/room1/control", "{}"),
    null,
  );
  assert.equal(validator.parseMessage("unknown/topic", "{}"), null);
  assert.throws(() =>
    validator.parseMessage("coasther/device/room1/control-status", "{}"),
  );
});

test("counter classifier supports baseline, increments, resets, conflict, out-of-order and cycle boundaries", () => {
  const previous = {
    reading_value: "100.000000",
    recorded_at: "2026-11-04T02:00:00Z",
    counter_epoch: 2,
    flock_cycle_id: 1,
  };
  const later = new Date("2026-11-04T02:01:00Z");
  assert.equal(classify(null, 100, later, 1).reading_status, "baseline");
  assert.equal(classify(previous, 102.125, later, 1).delta_value, "2.125000");
  assert.deepEqual(classify(previous, 1, later, 1), {
    reading_status: "reset",
    delta_value: "0.000000",
    counter_epoch: 3,
    is_latest: true,
  });
  assert.equal(classify(previous, 51, later, 1).reading_status, "suspect");
  assert.equal(
    classify(previous, 1, new Date("2026-11-04T01:59:00Z"), 1).reading_status,
    "out_of_order",
  );
  assert.equal(
    classify(previous, 101, new Date(previous.recorded_at), 1).reading_status,
    "suspect",
  );
  assert.equal(classify(previous, 101, later, 2).reading_status, "baseline");
});

test("historical cycle attribution rejects shared placement/harvest calendar boundaries", () => {
  const cycles = [
    { id: 1, placement_date: "2026-11-01", actual_harvest_date: "2026-11-04" },
    { id: 2, placement_date: "2026-11-04", actual_harvest_date: null },
  ];
  assert.equal(
    service.historicalCycle(
      cycles,
      new Date("2026-11-03T16:00:00Z"),
      "Asia/Makassar",
    ),
    null,
  );
  assert.equal(
    service.historicalCycle(
      cycles,
      new Date("2026-11-03T15:59:59Z"),
      "Asia/Makassar",
    ),
    1,
  );
  assert.equal(
    service.historicalCycle(
      cycles,
      new Date("2026-11-04T16:00:00Z"),
      "Asia/Makassar",
    ),
    2,
  );
});

test("partial telemetry preserves per-field timestamps and masks overlapping device measurements", () => {
  const old = {
    device_id: 1,
    source: "sensor",
    power_w: "66",
    voltage_v: "220",
    phase_data_json: JSON.stringify({
      metric_recorded_at: { power_w: "2026-11-04T01:00:00Z" },
      metric_device_id: { power_w: 1, voltage_v: 1 },
    }),
  };
  const partial = service.mergeSnapshot(
    old,
    { flow_rate_lpm: 2, recorded_at: new Date("2026-11-04T02:00:00Z") },
    { id: 1, coop_id: 2 },
    "sensor",
  );
  assert.equal(partial.power_w, 66);
  assert.equal(
    partial.phase_data_json.metric_recorded_at.power_w,
    "2026-11-04T01:00:00Z",
  );
  const overlap = service.mergeSnapshot(
    old,
    { power: 20, recorded_at: new Date("2026-11-04T02:00:00Z") },
    { id: 3, coop_id: 2 },
    "sensor",
  );
  assert.equal(overlap.power_w, null);
  assert.deepEqual(overlap.phase_data_json.ambiguous_metrics, ["power_w"]);
  assert.equal(
    service.mergeSnapshot(
      old,
      { power: 10, recorded_at: new Date() },
      { id: 1, coop_id: 2 },
      "simulation",
    ).voltage_v,
    null,
  );
});

test("invalid, unknown and diagnostic packets never access persistence", async (t) => {
  const lookup = t.mock.method(model, "meterByUid", async () =>
    assert.fail("Unexpected database lookup"),
  );
  assert.equal(
    (await service.handleMessage("unknown/topic", "{}")).outcome,
    "unknown_topic",
  );
  assert.equal(
    (await service.handleMessage("coasther/meter/uid/reading", "{")).outcome,
    "invalid_payload",
  );
  assert.equal(
    (
      await service.handleMessage(
        "coasther/device/room1/log",
        JSON.stringify({ password: "private" }),
      )
    ).outcome,
    "diagnostic_ignored",
  );
  assert.equal(lookup.mock.callCount(), 0);
  assert.equal(
    (
      await service.handleMessage(
        "coasther/meter/uid/reading",
        message(1, "2099-01-01T00:00:00Z"),
      )
    ).outcome,
    "invalid_timestamp",
  );
});

test("real telemetry supersedes a newer simulated snapshot without mixing its values", async (t) => {
  const connection = {
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    release() {},
  };
  t.mock.method(db, "getConnection", async () => connection);
  t.mock.method(model, "deviceByTopic", async () => ({ id: 1, coop_id: 2 }));
  t.mock.method(access, "lockCoop", async () => ({
    id: 2,
    farm_id: 3,
    status: "active",
  }));
  t.mock.method(model, "lockDevice", async () => ({
    id: 1,
    coop_id: 2,
    is_active: 1,
  }));
  t.mock.method(model, "farmContext", async () => ({
    is_active: 1,
    timezone: "Asia/Makassar",
  }));
  t.mock.method(model, "snapshot", async () => ({
    source: "simulation",
    power_w: 1000,
    recorded_at: new Date("2026-11-04T02:01:00Z"),
  }));
  const save = t.mock.method(model, "saveSnapshot", async (data) => {
    assert.equal(data.source, "sensor");
    assert.equal(data.power_w, null);
    assert.equal(data.voltage_v, 220);
  });
  const result = await service.handleMessage(
    "coasther/telemetry/room1/live",
    JSON.stringify({ voltage: 220, recorded_at: "2026-11-04T02:00:00Z" }),
    {
      receivedAt: new Date("2026-11-04T02:02:00Z"),
      heartbeat: false,
    },
  );
  assert.equal(result.outcome, "stored");
  assert.equal(save.mock.callCount(), 1);
});

test("retained real readings persist without becoming a new online heartbeat; SQL failure rolls back", async (t) => {
  const calls = [];
  const connection = {
    async beginTransaction() {
      calls.push("begin");
    },
    async commit() {
      calls.push("commit");
    },
    async rollback() {
      calls.push("rollback");
    },
    release() {
      calls.push("release");
    },
  };
  t.mock.method(db, "getConnection", async () => connection);
  t.mock.method(model, "meterByUid", async () => ({
    id: 1,
    device_id: 2,
    coop_id: 3,
  }));
  t.mock.method(access, "lockCoop", async () => ({
    id: 3,
    farm_id: 4,
    status: "active",
  }));
  t.mock.method(model, "lockDevice", async () => ({
    id: 2,
    coop_id: 3,
    is_active: 1,
  }));
  t.mock.method(model, "lockMeter", async () => ({
    id: 1,
    type: "water",
    unit: "liter",
    is_active: 1,
  }));
  t.mock.method(model, "farmContext", async () => ({
    timezone: "Asia/Makassar",
    is_active: 1,
  }));
  const seen = t.mock.method(model, "seen", async () =>
    assert.fail("Retained broker data must not imply online"),
  );
  t.mock.method(model, "duplicate", async () => null);
  t.mock.method(model, "cursor", async () => null);
  t.mock.method(model, "cycles", async () => []);
  t.mock.method(model, "timestampConflict", async () => false);
  t.mock.method(model, "insertReading", async () => 5);
  t.mock.method(model, "updateCursor", async () => {});
  const response = await service.handleMessage(
    "coasther/meter/uid/reading",
    message(1, "2026-11-04T01:00:00Z"),
    { heartbeat: false, receivedAt: new Date("2026-11-04T02:00:00Z") },
  );
  assert.equal(response.outcome, "stored");
  assert.equal(seen.mock.callCount(), 0);
  assert.deepEqual(calls, ["begin", "commit", "release"]);
  calls.length = 0;
  t.mock.method(model, "updateCursor", async () => {
    throw new Error("Injected update failure");
  });
  assert.equal(
    (
      await service.handleMessage(
        "coasther/meter/uid/reading",
        message(1, "2026-11-04T01:00:00Z"),
        { heartbeat: false, receivedAt: new Date("2026-11-04T02:00:00Z") },
      )
    ).outcome,
    "processing_error",
  );
  assert.deepEqual(calls, ["begin", "rollback", "release"]);
});

test("MQTT reconnect resubscribes once and its single message listener never publishes controls", async (t) => {
  const oldEnv = Object.fromEntries(
    ["MQTT_HOST", "MQTT_USERNAME", "MQTT_PASSWORD", "BROILER_MQTT_ENABLED"].map(
      (key) => [key, process.env[key]],
    ),
  );
  Object.assign(process.env, {
    MQTT_HOST: "example.invalid",
    MQTT_USERNAME: "mock",
    MQTT_PASSWORD: "mock",
    BROILER_MQTT_ENABLED: "true",
  });
  const client = new EventEmitter();
  let subscriptions = 0;
  client.subscribe = (topics, options, callback) => {
    subscriptions++;
    assert.equal(topics.length, 4);
    callback(null, []);
  };
  client.end = (force, options, callback) => callback();
  const handler = t.mock.method(service, "handleMessage", async () => ({
    outcome: "unknown_topic",
  }));
  const mqtt = require("../src/config/mqttBroiler").start({
    connect: () => client,
  });
  try {
    client.emit("connect");
    client.emit("reconnect");
    client.emit("connect");
    assert.equal(subscriptions, 2);
    assert.equal(client.listenerCount("message"), 1);
    client.emit("message", "coasther/meter/uid/reading", Buffer.from("{}"), {
      retain: true,
    });
    assert.equal(handler.mock.calls[0].arguments[2].heartbeat, false);
    client.emit("message", "coasther/telemetry/room1/live", Buffer.from("{}"), {
      retain: true,
    });
    assert.equal(handler.mock.callCount(), 1);
  } finally {
    await mqtt.stop();
    for (const [key, value] of Object.entries(oldEnv))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }
});
