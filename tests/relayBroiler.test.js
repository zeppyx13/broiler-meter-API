const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const db = require("../src/config/db");
const model = require("../src/models/relayBroiler.model");
const devices = require("../src/models/device.model");
const access = require("../src/services/access.service");
const accessModel = require("../src/models/access.model");
const service = require("../src/services/relayBroiler.service");
const schema = require("../src/validators/relayBroiler.validator");

const user = { id: 3, role: "manager" };
function setup(t) {
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
  const relay = {
    id: 21,
    device_id: 10,
    coop_id: 7,
    farm_id: 1,
    channel: 1,
    name: "Test relay",
    purpose: "other",
    is_enabled: 1,
    desired_state: "unknown",
    reported_state: "unknown",
    last_reported_at: null,
  };
  const device = {
    id: 10,
    coop_id: 7,
    device_type: "esp32",
    firmware_version: "3.1",
    mqtt_topic_key: "fixture_room",
    is_active: 1,
    last_seen_at: new Date(),
  };
  const commands = new Map();
  t.mock.method(db, "getConnection", async () => connection);
  t.mock.method(access, "lockCoop", async () => {
    calls.push("coop_lock");
    return { id: 7, farm_id: 1, status: "active" };
  });
  t.mock.method(accessModel, "lockFarm", async () => {
    calls.push("farm_lock");
    return { id: 1 };
  });
  t.mock.method(accessModel, "lockCoop", async () => {
    calls.push("coop_lock");
    return { id: 7, farm_id: 1, status: "active" };
  });
  t.mock.method(access, "requireCoop", async (actor, id, capability) => {
    calls.push(`access_${capability}`);
    return { id: 7, farm_id: 1, status: "active", farm_is_active: 1 };
  });
  t.mock.method(devices, "findById", async () => ({ ...device }));
  t.mock.method(devices, "findByTopicKey", async () => ({ ...device }));
  t.mock.method(devices, "lockById", async () => {
    calls.push("device_lock");
    return { ...device };
  });
  t.mock.method(model, "findById", async () => ({ ...relay }));
  t.mock.method(model, "lockById", async () => {
    calls.push("relay_lock");
    return { ...relay };
  });
  t.mock.method(model, "forDevice", async () => ({ ...relay }));
  t.mock.method(model, "farmIsActive", async () => true);
  t.mock.method(model, "latestCommand", async () => null);
  t.mock.method(model, "insertCommand", async (data) => {
    const command = {
      ...data,
      id: 81,
      status: "queued",
      source: "manual",
      published_at: null,
      acked_at: null,
      failure_reason: null,
    };
    commands.set(81, command);
    relay.desired_state = data.command;
    calls.push("audit_queued");
    return 81;
  });
  t.mock.method(model, "commandById", async (id) => ({ ...commands.get(id) }));
  t.mock.method(model, "lockCommand", async (id) => ({ ...commands.get(id) }));
  t.mock.method(model, "transition", async (id, status, date, reason) => {
    if (commands.get(id).status !== "queued") return false;
    Object.assign(commands.get(id), {
      status,
      failure_reason: reason,
      published_at: status === "published" ? date : null,
    });
    calls.push(`audit_${status}`);
    return true;
  });
  t.mock.method(model, "reportState", async (id, state, date) =>
    Object.assign(relay, { reported_state: state, last_reported_at: date }),
  );
  const oldToken = process.env.MQTT_CMD_TOKEN;
  process.env.MQTT_CMD_TOKEN = crypto.randomBytes(24).toString("hex");
  t.after(() => {
    service.configure();
    oldToken === undefined
      ? delete process.env.MQTT_CMD_TOKEN
      : (process.env.MQTT_CMD_TOKEN = oldToken);
  });
  return { calls, relay, device, commands };
}

test("relay validators permit only the single firmware channel and manual on/off commands", () => {
  assert.equal(
    schema.createSchema.parse({ device_id: 10, name: "Lamp" }).channel,
    1,
  );
  assert.equal(
    schema.createSchema.safeParse({ device_id: 10, name: "Lamp", channel: 2 })
      .success,
    false,
  );
  for (const body of [
    { command: "relay_on" },
    { command: "reboot" },
    { command: "on", topic: "other/topic" },
    { command: "off", token: "private" },
  ]) {
    assert.equal(schema.commandSchema.safeParse(body).success, false);
  }
  assert.equal(schema.updateSchema.safeParse({ device_id: 11 }).success, false);
  assert.equal(
    schema.updateSchema.safeParse({ reported_state: "on" }).success,
    false,
  );
});

test("manual command audit commits before QoS0 retain-false publication and never pretends device acknowledgement", async (t) => {
  const { calls, relay } = setup(t);
  service.configure({
    client: {
      connected: true,
      options: { queueQoSZero: false },
      publish(topic, payload, options, callback) {
        assert.equal(calls.includes("commit"), true);
        assert.equal(topic, "coasther/device/fixture_room/control");
        assert.equal(payload, `relay_on:${process.env.MQTT_CMD_TOKEN}`);
        assert.deepEqual(options, { qos: 0, retain: false });
        calls.push("publish");
        callback();
      },
    },
  });
  const result = await service.sendCommand(user, 21, { command: "on" });
  assert.equal(result.command.status, "published");
  assert.equal(result.command.source, "manual");
  assert.match(result.command.correlation_id, /^[0-9a-f-]{36}$/);
  assert.equal(result.command.acked_at, null);
  assert.equal(result.device_acknowledged, false);
  assert.equal(result.broker_receipt_confirmed, false);
  assert.equal(result.physical_state_confirmed, false);
  assert.equal(relay.reported_state, "unknown");
  assert.equal(relay.desired_state, "on");
  assert.equal(
    JSON.stringify(result).includes(process.env.MQTT_CMD_TOKEN),
    false,
  );
  assert.equal(calls.indexOf("publish") > calls.indexOf("commit"), true);
  assert.equal(calls.indexOf("coop_lock") < calls.indexOf("device_lock"), true);
  assert.equal(
    calls.indexOf("device_lock") < calls.indexOf("relay_lock"),
    true,
  );
});

test("unauthorized, disabled and stale devices cannot reserve or publish a command", async (t) => {
  const { commands, relay, device } = setup(t);
  service.configure({
    client: {
      connected: true,
      options: { queueQoSZero: false },
      publish() {
        assert.fail("Must not publish");
      },
    },
  });
  const denied = t.mock.method(access, "requireCoop", async () => {
    throw Object.assign(new Error("Forbidden"), { statusCode: 403 });
  });
  await assert.rejects(
    service.sendCommand({ id: 8, role: "operator" }, 21, { command: "on" }),
    { statusCode: 403 },
  );
  denied.mock.restore();
  relay.is_enabled = 0;
  await assert.rejects(service.sendCommand(user, 21, { command: "on" }), {
    statusCode: 409,
  });
  relay.is_enabled = 1;
  device.last_seen_at = null;
  await assert.rejects(service.sendCommand(user, 21, { command: "on" }), {
    statusCode: 409,
  });
  assert.equal(commands.size, 0);
});

test("offline broker and unsafe offline queue configurations create failed audit rows without sending", async (t) => {
  setup(t);
  service.configure({
    client: {
      connected: false,
      publish() {
        assert.fail("Offline publish forbidden");
      },
    },
  });
  assert.equal(
    (await service.sendCommand(user, 21, { command: "off" })).command
      .failure_reason,
    "broker_not_connected",
  );
  service.configure({
    client: {
      connected: true,
      options: { queueQoSZero: true },
      publish() {
        assert.fail("Queued publish forbidden");
      },
    },
  });
  assert.equal(
    (await service.sendCommand(user, 21, { command: "off" })).command
      .failure_reason,
    "offline_queue_not_disabled",
  );
});

test("publisher failures never copy broker error messages or server tokens into audit results", async (t) => {
  setup(t);
  const secret = `PRIVATE-${process.env.MQTT_CMD_TOKEN}`;
  service.configure({
    client: {
      connected: true,
      options: { queueQoSZero: false },
      publish(topic, payload, options, callback) {
        callback(
          Object.assign(new Error(secret), { sql: secret, password: secret }),
        );
      },
    },
  });
  const result = await service.sendCommand(user, 21, { command: "off" });
  assert.equal(result.command.status, "failed");
  assert.equal(result.command.failure_reason, "mqtt_publish_failed");
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test("an existing pending command blocks another device command across the database reservation gate", async (t) => {
  const { commands } = setup(t);
  t.mock.method(model, "latestCommand", async () => ({
    id: 80,
    status: "published",
    requested_at: new Date(),
  }));
  t.mock.method(model, "expire", async () => false);
  await assert.rejects(service.sendCommand(user, 21, { command: "off" }), {
    statusCode: 409,
  });
  assert.equal(commands.size, 0);
});

test("a queued command is checked again before publishing after state or authorization changes", async (t) => {
  const { relay, commands } = setup(t);
  service.configure({
    client: {
      connected: true,
      options: { queueQoSZero: false },
      publish() {
        assert.fail("Stale reservation must not publish");
      },
    },
  });
  // Simulate the device being disabled between the first reservation and final target validation.
  const originalLock = model.lockById;
  let locks = 0;
  t.mock.method(model, "lockById", async (...args) => {
    locks++;
    if (locks === 2) relay.is_enabled = 0;
    return originalLock(...args);
  });
  const result = await service.sendCommand(user, 21, { command: "on" });
  assert.equal(result.command.status, "failed");
  assert.equal(result.command.failure_reason, "target_state_changed");
  assert.equal(commands.size, 1);
});

test("a revoked manager cannot publish an already reserved command", async (t) => {
  setup(t);
  service.configure({
    client: {
      connected: true,
      options: { queueQoSZero: false },
      publish() {
        assert.fail("Revoked access must not publish");
      },
    },
  });
  let checks = 0;
  t.mock.method(access, "requireCoop", async () => {
    if (++checks === 2)
      throw Object.assign(new Error("Forbidden"), { statusCode: 403 });
    return { id: 7, status: "active", farm_is_active: 1 };
  });
  const result = await service.sendCommand(user, 21, { command: "on" });
  assert.equal(result.command.status, "failed");
  assert.equal(
    result.command.failure_reason,
    "authorization_revoked_before_publication",
  );
});

test("a reservation replaced or timed out before publication never sends the old request", async (t) => {
  const { commands } = setup(t);
  service.configure({
    client: {
      connected: true,
      options: { queueQoSZero: false },
      publish() {
        assert.fail("Expired reservation must not publish");
      },
    },
  });
  t.mock.method(model, "lockCommand", async (id) => {
    commands.get(id).status = "timed_out";
    return { ...commands.get(id) };
  });
  const result = await service.sendCommand(user, 21, { command: "on" });
  assert.equal(result.command.status, "timed_out");
});

test("publication callback timeout is auditable uncertainty, not proof of cancellation or physical failure", async (t) => {
  setup(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  service.configure({
    client: {
      connected: true,
      options: { queueQoSZero: false },
      publish() {
        entered();
      },
    },
  });
  const pending = service.sendCommand(user, 21, { command: "off" });
  await started;
  t.mock.timers.tick(5000);
  const result = await pending;
  assert.equal(result.command.status, "timed_out");
  assert.match(result.command.failure_reason, /not cancellation/);
  assert.equal(result.physical_state_confirmed, false);
  assert.equal(result.command.acked_at, null);
});

function status(overrides = {}) {
  return {
    room_id: 999,
    relay_cutoff: false,
    relay_state: "on",
    source: "mqtt_command",
    result: "relay_on_executed",
    recorded_at: new Date().toISOString(),
    ...overrides,
  };
}

test("control status validates consistency and only records observed state without command ACK", async (t) => {
  const { relay, commands } = setup(t);
  commands.set(81, { id: 81, status: "published", acked_at: null });
  assert.equal(
    schema.controlStatusSchema.safeParse(status({ relay_cutoff: true }))
      .success,
    false,
  );
  assert.equal(
    schema.controlStatusSchema.safeParse(status({ source: "mqtt_connect" }))
      .success,
    false,
  );
  const result = await service.observeControlStatus("fixture_room", status());
  assert.equal(result.outcome, "observed");
  assert.equal(relay.reported_state, "on");
  assert.equal(commands.get(81).status, "published");
  assert.equal(commands.get(81).acked_at, null);
});

test("retained sync may initialize fresh state but cannot overwrite existing state or acknowledge a command", async (t) => {
  const { relay } = setup(t);
  const result = await service.observeControlStatus(
    "fixture_room",
    status({ source: "mqtt_connect", result: "relay_state_sync" }),
    { retained: true },
  );
  assert.equal(result.outcome, "observed");
  const next = await service.observeControlStatus(
    "fixture_room",
    status({
      relay_cutoff: true,
      relay_state: "off",
      result: "relay_off_executed",
    }),
    { retained: true },
  );
  assert.equal(next.outcome, "stale_status");
  assert.equal(relay.reported_state, "on");
});

test("old/future/replayed and simulated status cannot masquerade as the current physical state", async (t) => {
  const { relay } = setup(t);
  const now = new Date();
  assert.equal(
    (
      await service.observeControlStatus(
        "fixture_room",
        status({
          recorded_at: new Date(now.getTime() - 3600000).toISOString(),
        }),
      )
    ).outcome,
    "stale_or_invalid_status",
  );
  assert.equal(
    (
      await service.observeControlStatus(
        "fixture_room",
        status({
          recorded_at: new Date(now.getTime() + 3600000).toISOString(),
        }),
      )
    ).outcome,
    "stale_or_invalid_status",
  );
  assert.equal(
    (
      await service.observeControlStatus("fixture_room", status(), {
        source: "simulation",
      })
    ).outcome,
    "simulation_ignored",
  );
  assert.equal(relay.reported_state, "unknown");
  await service.observeControlStatus("fixture_room", status());
  assert.equal(
    (
      await service.observeControlStatus(
        "fixture_room",
        status({
          relay_cutoff: true,
          relay_state: "off",
          result: "relay_off_executed",
        }),
      )
    ).outcome,
    "stale_status",
  );
});

test("telemetry observation uses mapped device identity and ignores simulation instead of creating physical state", async (t) => {
  const { relay } = setup(t);
  const payload = { relay_cutoff: true, room_id: 999, recorded_at: new Date() };
  assert.equal(
    (
      await service.observeTelemetry({ device_id: 10, coop_id: 7 }, payload, {
        source: "simulation",
      })
    ).outcome,
    "simulation_ignored",
  );
  assert.equal(
    (await service.observeTelemetry({ device_id: 10, coop_id: 7 }, payload))
      .outcome,
    "observed",
  );
  assert.equal(relay.reported_state, "off");
});

test("watchdog marks uncorrelated commands timed out without inventing ACK or changing reported state", async (t) => {
  const { relay, commands } = setup(t);
  commands.set(81, {
    id: 81,
    relay_id: 21,
    status: "published",
    acked_at: null,
  });
  t.mock.method(model, "pendingBefore", async () => [
    { id: 81, relay_id: 21, device_id: 10, coop_id: 7 },
  ]);
  t.mock.method(model, "expire", async (id) => {
    commands.get(id).status = "timed_out";
    return true;
  });
  assert.equal(await service.checkTimeouts(), 1);
  assert.equal(commands.get(81).status, "timed_out");
  assert.equal(commands.get(81).acked_at, null);
  assert.equal(relay.reported_state, "unknown");
});
