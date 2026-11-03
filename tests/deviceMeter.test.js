const { test } = require("node:test");
const assert = require("node:assert/strict");
const db = require("../src/config/db");
const access = require("../src/services/access.service");
const devices = require("../src/models/device.model");
const meters = require("../src/models/meterBroiler.model");
const meterService = require("../src/services/meterBroiler.service");
const deviceService = require("../src/services/device.service");
const deviceSchema = require("../src/validators/device.validator");
const meterSchema = require("../src/validators/meterBroiler.validator");

const user = { id: 21, role: "manager" };
const device = { id: 5, coop_id: 3, is_active: 1 };
const activeCoop = { id: 3, status: "active", farm_is_active: 1 };

function mockTransaction(t, calls = []) {
  const connection = {
    beginTransaction: async () => calls.push("begin"),
    commit: async () => calls.push("commit"),
    rollback: async () => calls.push("rollback"),
    release: () => calls.push("release"),
  };
  t.mock.method(db, "getConnection", async () => connection);
  return connection;
}

function mockParentLocks(t, calls = []) {
  t.mock.method(devices, "findById", async () => device);
  t.mock.method(access, "lockCoop", async () => calls.push("farm-coop"));
  t.mock.method(access, "requireCoop", async (actor, id, capability) => {
    assert.equal(capability, "manage");
    assert.equal(id, device.coop_id);
    calls.push("authorize");
    return activeCoop;
  });
  t.mock.method(devices, "lockById", async () => {
    calls.push("device");
    return device;
  });
}

test("pairing validation uses literal legacy topic segments and correct units", () => {
  const pairedDevice = deviceSchema.createSchema.parse({
    coop_id: 3,
    device_uid: "esp32_room1",
    mqtt_topic_key: "room1",
    name: "Panel Kandang",
  });
  assert.equal(pairedDevice.mqtt_topic_key, "room1");
  assert.equal(pairedDevice.device_type, "esp32");
  for (const topic of ["room/1", "room+", "#", "room 1", "room\n1"]) {
    assert.equal(
      deviceSchema.createSchema.safeParse({
        ...pairedDevice,
        mqtt_topic_key: topic,
      }).success,
      false,
    );
  }
  assert.equal(
    meterSchema.createSchema.safeParse({
      device_id: 5,
      meter_uid: "room1_water",
      type: "water",
      unit: "kwh",
    }).success,
    false,
  );
  assert.equal(
    meterSchema.createSchema.safeParse({
      device_id: 5,
      meter_uid: "room1_power",
      type: "electricity",
      unit: "liter",
    }).success,
    false,
  );
  assert.equal(
    meterSchema.createSchema.parse({
      device_id: 5,
      meter_uid: "room1_water",
      type: "water",
      unit: "liter",
    }).channel,
    "main",
  );
});

test("updates cannot remap identities or fabricate connectivity and cumulative counters", () => {
  for (const field of [
    "coop_id",
    "device_uid",
    "mqtt_topic_key",
    "last_seen_at",
    "connectivity_status",
  ]) {
    assert.equal(
      deviceSchema.updateSchema.safeParse({ [field]: "replacement" }).success,
      false,
    );
  }
  for (const field of [
    "device_id",
    "meter_uid",
    "type",
    "unit",
    "channel",
    "last_reading_value",
    "counter_epoch",
  ]) {
    assert.equal(
      meterSchema.updateSchema.safeParse({ [field]: "replacement" }).success,
      false,
    );
  }
  assert.equal(meterSchema.updateSchema.safeParse({}).success, false);
  assert.equal(
    meterSchema.updateSchema.safeParse({ installed_at: "2026-11-04T10:30:00" })
      .success,
    false,
  );
  assert.equal(
    meterSchema.updateSchema.safeParse({
      installed_at: "2026-11-04T10:30:00+08:00",
    }).success,
    true,
  );
});

test("meter pairing requires manage access before any insert", async (t) => {
  const calls = [];
  mockTransaction(t, calls);
  t.mock.method(devices, "findById", async () => device);
  t.mock.method(access, "lockCoop", async () => {});
  t.mock.method(access, "requireCoop", async (actor, id, capability) => {
    assert.equal(capability, "manage");
    throw Object.assign(new Error("Forbidden"), { statusCode: 403 });
  });
  const insert = t.mock.method(meters, "create", async () =>
    assert.fail("Unauthorized pairing must not insert"),
  );
  await assert.rejects(
    meterService.create({ id: 22, role: "operator" }, { device_id: 5 }),
    { statusCode: 403 },
  );
  assert.equal(insert.mock.callCount(), 0);
  assert.deepEqual(calls, ["begin", "rollback", "release"]);
});

test("aggregate electrical channel cannot coexist with configured phases", async (t) => {
  const calls = [];
  mockTransaction(t, calls);
  mockParentLocks(t, calls);
  t.mock.method(meters, "electricalChannels", async () => [
    { id: 7, channel: "phase_a" },
  ]);
  const insert = t.mock.method(meters, "create", async () =>
    assert.fail("Overlapping meter must not insert"),
  );
  await assert.rejects(
    meterService.create(user, {
      device_id: 5,
      type: "electricity",
      channel: "total",
    }),
    { statusCode: 409 },
  );
  assert.equal(insert.mock.callCount(), 0);
  assert.deepEqual(calls, [
    "begin",
    "farm-coop",
    "authorize",
    "device",
    "rollback",
    "release",
  ]);
});

test("phase pairing rejects an aggregate and duplicate phase but permits a distinct phase", async (t) => {
  mockTransaction(t);
  mockParentLocks(t);
  let channels = [{ id: 7, channel: "main" }];
  t.mock.method(meters, "electricalChannels", async () => channels);
  t.mock.method(meters, "create", async () => 8);
  t.mock.method(meters, "lockById", async () => ({
    id: 8,
    device_id: 5,
    channel: "phase_b",
  }));
  const data = meterSchema.createSchema.parse({
    device_id: 5,
    meter_uid: "room1_phase_b",
    type: "electricity",
    channel: "phase_b",
    unit: "kwh",
  });
  await assert.rejects(meterService.create(user, data), { statusCode: 409 });
  channels = [{ id: 7, channel: "phase_b" }];
  await assert.rejects(meterService.create(user, data), { statusCode: 409 });
  channels = [{ id: 7, channel: "phase_a" }];
  assert.equal((await meterService.create(user, data)).meter.id, 8);
});

test("pairing an inactive device is rejected while historical configuration remains readable", async (t) => {
  mockTransaction(t);
  mockParentLocks(t);
  t.mock.method(devices, "lockById", async () => ({ ...device, is_active: 0 }));
  const insert = t.mock.method(meters, "create", async () =>
    assert.fail("Inactive device must not receive pairing"),
  );
  await assert.rejects(
    meterService.create(user, { device_id: 5, type: "water", channel: "main" }),
    { statusCode: 409 },
  );
  assert.equal(insert.mock.callCount(), 0);
});

test("soft disable preserves meter counter and follows farm-coop-device-meter lock order", async (t) => {
  const calls = [];
  const connection = mockTransaction(t, calls);
  mockParentLocks(t, calls);
  const row = {
    id: 8,
    device_id: 5,
    is_active: 1,
    installed_at: null,
    last_reading_value: "125.000000",
    counter_epoch: 2,
  };
  t.mock.method(meters, "findById", async () => row);
  t.mock.method(meters, "lockById", async () => {
    calls.push("meter");
    return row;
  });
  t.mock.method(meters, "update", async (id, data, conn) => {
    assert.equal(conn, connection);
    assert.equal(data.is_active, false);
    assert.equal(data.last_reading_value, "125.000000");
    assert.equal(data.counter_epoch, 2);
    calls.push("update");
  });
  await meterService.remove(user, 8);
  assert.deepEqual(calls, [
    "begin",
    "farm-coop",
    "authorize",
    "device",
    "meter",
    "update",
    "meter",
    "commit",
    "release",
  ]);
});

test("cross-farm meter detail is denied rather than returning pairing data", async (t) => {
  t.mock.method(meters, "findById", async () => ({
    id: 8,
    device_id: 5,
    meter_uid: "private_uid",
  }));
  t.mock.method(devices, "findById", async () => device);
  t.mock.method(access, "requireCoop", async () => {
    throw Object.assign(new Error("Forbidden"), { statusCode: 403 });
  });
  await assert.rejects(meterService.detail({ id: 99, role: "manager" }, 8), {
    statusCode: 403,
  });
});

test("device pairing starts unknown until a real receipt rather than assuming it is online", async (t) => {
  mockTransaction(t);
  mockParentLocks(t);
  t.mock.method(devices, "create", async () => 5);
  t.mock.method(devices, "lockById", async () => ({
    ...device,
    last_seen_at: null,
    connectivity_status: "unknown",
  }));
  const result = await deviceService.create(
    user,
    deviceSchema.createSchema.parse({
      coop_id: 3,
      device_uid: "esp32_room1",
      mqtt_topic_key: "room1",
      name: "Panel",
    }),
  );
  assert.equal(result.device.connectivity_status, "unknown");
  assert.equal(result.device.last_seen_at, null);
});

test("device disable changes configuration while retaining last receipt and identity", async (t) => {
  const calls = [];
  mockTransaction(t, calls);
  mockParentLocks(t, calls);
  const row = {
    ...device,
    device_uid: "esp32_room1",
    mqtt_topic_key: "room1",
    name: "Panel",
    device_type: "esp32",
    firmware_version: "3.1",
    last_seen_at: new Date("2026-11-04T02:30:00Z"),
  };
  t.mock.method(devices, "lockById", async () => ({ ...row }));
  t.mock.method(devices, "update", async (id, data) => {
    assert.equal(data.is_active, false);
    assert.equal(data.device_uid, row.device_uid);
    assert.equal(data.mqtt_topic_key, row.mqtt_topic_key);
    assert.equal(data.last_seen_at, row.last_seen_at);
    calls.push("update");
  });
  await deviceService.remove(user, 5);
  assert.deepEqual(calls, [
    "begin",
    "farm-coop",
    "authorize",
    "update",
    "commit",
    "release",
  ]);
});
