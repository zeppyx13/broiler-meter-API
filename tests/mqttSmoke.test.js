const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { execFileSync } = require("node:child_process");
const { observe } = require("../src/scripts/smoke_broiler_mqtt");

const env = {
  MQTT_HOST: "broker.example.invalid",
  MQTT_USERNAME: "fixture-user",
  MQTT_PASSWORD: "fixture-password",
  MQTT_SMOKE_SECONDS: "5",
};

function client() {
  const fake = new EventEmitter();
  fake.publish = () => assert.fail("Passive smoke must never publish");
  fake.end = (force) => { fake.ended = force; };
  fake.subscribe = (topics, options, callback) => {
    assert.equal(options.qos, 0);
    assert.equal(topics.length, 4);
    assert.equal(topics.some((topic) => topic.endsWith("/control")), false);
    callback(null, topics.map((topic) => ({ topic, qos: 0 })));
  };
  return fake;
}

test("MQTT smoke import starts nothing and loads no application/database/worker module", () => {
  const script = `
    const assert = require('node:assert/strict');
    const path = require('node:path');
    const sourceRoot = path.dirname(path.dirname(process.argv[1])) + path.sep;
    const before = new Set(Object.keys(require.cache));
    require(process.argv[1]);
    const added = Object.keys(require.cache).filter(file => !before.has(file) && file.startsWith(sourceRoot));
    assert.deepEqual(added, [process.argv[1]]);
  `;
  execFileSync(process.execPath, ["-e", script, require.resolve("../src/scripts/smoke_broiler_mqtt")]);
});

test("MQTT smoke independently subscribes over TLS, counts packets only and closes within its deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fake = client();
  const pending = observe({ env, connect: (options) => {
    assert.equal(options.protocol, "mqtts");
    assert.equal(options.rejectUnauthorized, true);
    assert.equal(options.reconnectPeriod, 0);
    assert.equal(options.queueQoSZero, false);
    return fake;
  } });
  fake.emit("connect");
  for (const topic of ["coasther/meter/unit/reading", "coasther/telemetry/unit/live", "coasther/device/unit/log", "coasther/device/unit/control-status"])
    fake.emit("message", topic, Buffer.from("private payload must not be processed"));
  t.mock.timers.tick(5000);
  const result = await pending;
  assert.equal(result.success, true);
  assert.deepEqual(result.received, { meter: 1, telemetry: 1, diagnostic: 1, control_status: 1 });
  assert.equal(fake.ended, true);
  assert.equal(JSON.stringify(result).includes("private"), false);
  assert.equal(JSON.stringify(result).includes(env.MQTT_PASSWORD), false);
  fake.emit("error", new Error("late private error"));
});

test("MQTT smoke disabled or invalid configuration fails without connecting", async () => {
  for (const config of [{ ...env, BROILER_MQTT_ENABLED: "false" }, {}, { ...env, MQTT_SMOKE_SECONDS: "61" }, { ...env, MQTT_PORT: "invalid" }]) {
    const result = await observe({ env: config, connect: () => assert.fail("Must not connect") });
    assert.equal(result.success, false);
  }
});

test("MQTT smoke safely terminates on errors, refused subscriptions or a broker that never responds", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const missing = client();
  const pending = observe({ env, connect: () => missing });
  t.mock.timers.tick(5000);
  assert.equal((await pending).reason, "connection_not_observed");
  assert.equal(missing.ended, true);

  const failed = client();
  const error = observe({ env, connect: () => failed });
  failed.emit("error", new Error("private credential detail"));
  assert.equal((await error).reason, "mqtt_connection_error");
  assert.equal(failed.ended, true);

  const refused = client();
  refused.subscribe = (topics, options, callback) => callback(null, [{ qos: 128 }]);
  const denied = observe({ env, connect: () => refused });
  refused.emit("connect");
  assert.equal((await denied).reason, "mqtt_subscription_failed");
  assert.equal(refused.ended, true);

  const thrown = await observe({ env, connect: () => { throw new Error("private credential detail"); } });
  assert.equal(thrown.reason, "mqtt_connection_error");
  assert.equal(JSON.stringify(thrown).includes("private"), false);
});
