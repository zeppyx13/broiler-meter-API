const { test } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const {
  createRuntime,
} = require("../src/services/broilerPhase3Runtime.service");
const inputHealth = require("../src/utils/iotInputHealth");

test("postcommit Guard is deferred, coalesces per device and keeps a relay observation across meter messages", async () => {
  const calls = [];
  const runtime = createRuntime({
    evaluate: async (id, options) => calls.push(["guard", id, options.source]),
    observe: async (result, payload) =>
      calls.push(["relay", result.device_id, payload.relay_cutoff]),
  });
  runtime.configure();
  const result = { outcome: "stored", coop_id: 10, device_id: 20 };
  const pending = runtime.enqueue(
    result,
    { relay_cutoff: true },
    { source: "simulation" },
  );
  assert.deepEqual(calls, []);
  assert.equal(
    runtime.enqueue(result, null, { source: "simulation" }),
    pending,
  );
  await pending;
  assert.deepEqual(calls, [
    ["relay", 20, true],
    ["guard", 10, "simulation"],
  ]);
  await runtime.stop();
});

test("Guard and relay failures are sanitized and never reject the committed ingestion job", async () => {
  const reports = [];
  const runtime = createRuntime({
    evaluate: async () => {
      throw new Error("private");
    },
    observe: async () => {
      throw new Error("private");
    },
    report: (context) => reports.push(context),
  });
  runtime.configure();
  await runtime.enqueue(
    { outcome: "stored", coop_id: 1, device_id: 2 },
    { relay_cutoff: false },
  );
  assert.equal(reports.length, 2);
  assert.equal(JSON.stringify(reports).includes("private"), false);
  await runtime.stop();
});

test("buffered telemetry cannot displace a newer pending relay observation or overwrite equal-time state", async () => {
  const observed = [];
  const runtime = createRuntime({
    evaluate: async () => {},
    observe: async (_, payload) => observed.push(payload),
  });
  runtime.configure();
  const result = { outcome: "stored", coop_id: 10, device_id: 20 };
  const latest = {
    relay_cutoff: false,
    recorded_at: new Date("2026-11-05T01:00:10Z"),
  };
  const waiting = runtime.enqueue(result, latest);
  runtime.enqueue(
    { ...result, outcome: "historical_telemetry" },
    { relay_cutoff: true, recorded_at: new Date("2026-11-05T01:00:05Z") },
  );
  runtime.enqueue(
    { ...result, outcome: "historical_telemetry" },
    { relay_cutoff: true, recorded_at: latest.recorded_at },
  );
  await waiting;
  assert.deepEqual(observed, [latest]);
  await runtime.stop();
});

test("a pending SMTP worker cannot hold the watchdog, and overlapping ticks do not duplicate jobs", async () => {
  const calls = { statuses: 0, watchdog: 0, timeouts: 0, emails: 0 };
  let release;
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  const dependencies = Object.fromEntries(
    Object.keys(calls).map((name) => [
      name,
      async () => {
        calls[name]++;
        if (name === "emails") await waiting;
      },
    ]),
  );
  const runtime = createRuntime(dependencies);
  runtime.configure();
  const first = runtime.tick();
  await new Promise((resolve) => setImmediate(resolve));
  const second = runtime.tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, { statuses: 2, watchdog: 2, timeouts: 2, emails: 1 });
  release();
  await Promise.all([first, second]);
  await runtime.stop();
});

test("runtime remains inactive until configured and stopping prevents later work", async () => {
  let calls = 0;
  const runtime = createRuntime({ evaluate: async () => calls++ });
  const result = { outcome: "stored", coop_id: 1 };
  assert.equal(runtime.enqueue(result), null);
  runtime.configure();
  assert.equal(runtime.enqueue({ ...result, outcome: "disabled" }), null);
  await runtime.enqueue(result);
  await runtime.stop();
  assert.equal(runtime.enqueue(result), null);
  assert.equal(calls, 1);
});

test("Broiler profile refuses FCM tokens and application loads no Firebase or legacy push module", () => {
  const output = execFileSync(
    process.execPath,
    [
      "-e",
      `
    const assert = require('node:assert/strict');
    const schema = require('./src/validators/user.validator').updateMeSchema;
    assert.equal(schema.safeParse({ fcm_token: 'synthetic' }).success, false);
    assert.equal(schema.safeParse({ fcm_token: null }).success, false);
    assert.equal(schema.safeParse({ name: 'Web user' }).success, true);
    require('./src/app');
    assert.equal(Object.keys(require.cache).some(p => /firebase-admin|fcm-sender/.test(p)), false);
    require('./src/services/user.service').updateMe(1, {fcm_token:'synthetic'}).then(
      () => { process.exitCode=1; }, error => { assert.equal(error.statusCode, 400); console.log('web_only_pass'); });
  `,
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, DB_NAME: "coasther_broiler", NODE_ENV: "test" },
      encoding: "utf8",
    },
  );
  assert.match(output, /web_only_pass/);
});

test("malformed live timestamps expose bounded diagnostic context without creating a heartbeat or substituting a time", async (t) => {
  const service = require("../src/services/iotBroiler.service");
  const model = require("../src/models/iotBroiler.model");
  const diagnostics = require("../src/utils/mqttDiagnostics");
  t.mock.method(diagnostics, "report", () => {});
  const lookup = t.mock.method(model, "deviceByTopic", async () => null);
  const seen = t.mock.method(model, "seen", async () =>
    assert.fail("Invalid time must not establish heartbeat"),
  );
  const receivedAt = new Date("2026-11-05T02:00:00Z");
  const topic = "coasther/telemetry/phase3-health-fixture/live";
  const message = JSON.stringify({
    flow_rate_lpm: 0,
    recorded_at: "2000-18-10T00:130:09+08:0",
  });
  assert.equal(
    (await service.handleMessage(topic, message, { receivedAt })).outcome,
    "invalid_payload",
  );
  assert.equal(
    inputHealth
      .recentInvalidTimestamp("phase3-health-fixture", receivedAt)
      .toISOString(),
    receivedAt.toISOString(),
  );
  assert.equal(lookup.mock.callCount(), 0);
  assert.equal(seen.mock.callCount(), 0);
  inputHealth.clear("phase3-health-fixture");
  await service.handleMessage(topic, message, {
    receivedAt,
    source: "simulation",
  });
  await service.handleMessage(topic, message, { receivedAt, retained: true });
  assert.equal(
    inputHealth.recentInvalidTimestamp("phase3-health-fixture", receivedAt),
    null,
  );
  inputHealth.recordInvalidTimestamp("phase3-health-fixture", receivedAt);
  await service.handleMessage(
    topic,
    JSON.stringify({ flow_rate_lpm: 0, recorded_at: receivedAt.toISOString() }),
    { receivedAt },
  );
  assert.equal(
    inputHealth.recentInvalidTimestamp("phase3-health-fixture", receivedAt),
    null,
  );
  inputHealth.recordInvalidTimestamp("phase3-health-fixture", receivedAt);
  assert.equal(
    inputHealth.recentInvalidTimestamp(
      "phase3-health-fixture",
      new Date(receivedAt.getTime() + 86400000),
    ),
    null,
  );
});

test("control-status dispatch preserves retained flag and never reaches sensor ingestion", async (t) => {
  const relay = require("../src/services/relayBroiler.service");
  const service = require("../src/services/iotBroiler.service");
  const model = require("../src/models/iotBroiler.model");
  const receivedAt = new Date("2026-11-05T02:00:00Z");
  const observer = t.mock.method(
    relay,
    "observeControlStatus",
    async (key, payload, options) => {
      assert.equal(key, "phase3-status-fixture");
      assert.equal(options.retained, true);
      assert.equal(payload.relay_state, "off");
      assert.equal(payload.recorded_at.toISOString(), receivedAt.toISOString());
      return { outcome: "observed" };
    },
  );
  t.mock.method(model, "deviceByTopic", async () =>
    assert.fail("Control status is not sensor telemetry"),
  );
  const result = await service.handleMessage(
    "coasther/device/phase3-status-fixture/control-status",
    JSON.stringify({
      relay_cutoff: true,
      relay_state: "off",
      source: "mqtt_connect",
      result: "relay_state_sync",
      recorded_at: receivedAt.toISOString(),
    }),
    { retained: true, receivedAt },
  );
  assert.equal(observer.mock.callCount(), 1);
  assert.equal(result.outcome, "observed");
});
