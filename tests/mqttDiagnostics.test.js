const { test } = require("node:test");
const assert = require("node:assert/strict");
const { z } = require("zod");
const { createDiagnostics } = require("../src/utils/mqttDiagnostics");

function fixture(options = {}) {
  const messages = [];
  const logger = Object.fromEntries(["warn", "info", "error"].map((level) => [level, (...args) => {
    assert.equal(args.length, 1);
    assert.equal(typeof args[0], "string");
    messages.push({ level, text: args[0], record: JSON.parse(args[0]) });
  }]));
  return { messages, diagnostics: createDiagnostics({ logger, ...options }) };
}

test("diagnostics retain safe topic, processing context and exception codes without private payload/error/SQL values", () => {
  const { messages, diagnostics } = fixture();
  const secret = "PRIVATE-SSID-PASSWORD-COMMAND-TOKEN";
  const error = Object.assign(new Error(secret), {
    code: "ER_LOCK_DEADLOCK", statusCode: 409, sql: `SELECT '${secret}'`, sqlMessage: secret,
    stack: `Error: ${secret}\n    at insertReading (J:/${secret}/model.js:1:2)\n    at ${secret} (secret.js:1:2)\n    at async ingestReading (secret.js:1:2)`,
  });
  diagnostics.report({
    topic: "coasther/meter/esp32_room1_water/reading", kind: "meter", stage: "insert_reading", outcome: "processing_error",
    payload_bytes: 89, source: "mqtt", retained: false, persisted: false, coop_id: 7, device_id: 10, meter_id: "13",
    payload: { wifi_ssid: secret }, password: secret, raw: secret,
  }, error);
  const record = messages[0].record;
  assert.equal(messages[0].text.includes(secret), false);
  assert.equal(record.pid, process.pid);
  assert.equal(record.topic, "coasther/meter/esp32_room1_water/reading");
  assert.equal(record.stage, "insert_reading");
  assert.equal(record.error_code, "ER_LOCK_DEADLOCK");
  assert.equal(record.reason_code, "DATABASE_ERROR");
  assert.equal(record.status_code, 409);
  assert.equal(record.persisted, false);
  assert.equal(record.meter_id, 13);
  assert.deepEqual(record.stack_frames, ["insertReading", "ingestReading"]);
});

test("validation issue diagnostics use only bounded schema paths and codes, never inputs or arbitrary key names", () => {
  const { messages, diagnostics } = fixture();
  const secret = "PRIVATE-ISSUE-VALUE";
  const error = {
    name: "ZodError", message: secret,
    issues: Array.from({ length: 20 }, (_, index) => ({
      path: index ? [secret, "recorded_at", 1] : ["power"], code: index ? secret : "invalid_type", input: secret, message: secret,
    })),
  };
  diagnostics.report({ topic: "coasther/telemetry/room1/live", kind: "telemetry", stage: "validation", payload_bytes: 234 }, error);
  const record = messages[0].record;
  assert.equal(record.reason_code, "VALIDATION_ERROR");
  assert.deepEqual(record.issues[0], { path: "power", code: "invalid_type" });
  assert.deepEqual(record.issues[1], { path: "[redacted].recorded_at.1", code: "unknown" });
  assert.equal(record.issues.length, 8);
  assert.equal(messages[0].text.includes(secret), false);
  const issue = z.object({ power: z.number() }).safeParse({ power: secret });
  diagnostics.report({ topic: "coasther/telemetry/room2/live", kind: "telemetry", stage: "validation" }, issue.error);
  assert.equal(messages[1].text.includes(secret), false);
  assert.deepEqual(messages[1].record.issues, [{ path: "power", code: "invalid_type" }]);
});

test("unknown context strings, invalid topics and unknown exception metadata are redacted", () => {
  const { messages, diagnostics } = fixture();
  const secret = "PRIVATE-CONTEXT";
  diagnostics.report({
    topic: `coasther/unknown/${secret}\n/log`, kind: secret, stage: secret, source: secret, outcome: secret,
    reason_code: secret, payload_bytes: secret, persisted: secret, device_id: secret,
  }, { name: secret, code: secret, message: secret, stack: secret, sql: secret });
  const record = messages[0].record;
  assert.equal(record.topic, "[unrecognized-topic]");
  assert.equal(record.kind, "unknown");
  assert.equal(record.stage, "unknown");
  assert.equal(record.reason_code, "UNEXPECTED_ERROR");
  assert.equal(record.error_class, "Error");
  assert.equal(record.error_code, "UNEXPECTED_ERROR");
  assert.equal(messages[0].text.includes(secret), false);
});

test("identical warning storms emit immediately then report the suppressed count after the window", () => {
  let time = 0;
  const { messages, diagnostics } = fixture({ now: () => time, windowMs: 30000 });
  const context = { topic: "coasther/meter/uid/reading", kind: "meter", stage: "json", outcome: "invalid_payload" };
  diagnostics.report(context, new SyntaxError("private payload"));
  for (let repeat = 0; repeat < 100; repeat++) diagnostics.report(context, new SyntaxError("another private payload"));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].record.suppressed_count, 0);
  time = 30000;
  diagnostics.report(context, new SyntaxError("not printed"));
  assert.equal(messages.length, 2);
  assert.equal(messages[1].record.suppressed_count, 100);
  assert.equal(messages[1].record.reason_code, "JSON_PARSE_ERROR");
});

test("rate-limit storage is bounded and different causes or schema issues are independently visible", () => {
  const { messages, diagnostics } = fixture({ now: () => 0, maxKeys: 2 });
  const context = { topic: "coasther/telemetry/room1/live", kind: "telemetry", stage: "validation" };
  diagnostics.report(context, { name: "ZodError", issues: [{ path: ["power"], code: "invalid_type" }] });
  diagnostics.report(context, { name: "ZodError", issues: [{ path: ["recorded_at"], code: "invalid_format" }] });
  diagnostics.report({ ...context, topic: "coasther/telemetry/room2/live" }, new TypeError("private"));
  diagnostics.report(context, { name: "ZodError", issues: [{ path: ["power"], code: "invalid_type" }] });
  assert.equal(messages.length, 4);
  assert.equal(messages.every((message) => message.record.suppressed_count === 0), true);
});

test("metric retry diagnostics preserve recovery state and allow only bounded function frames", () => {
  const { messages, diagnostics } = fixture();
  diagnostics.report({
    topic: "coasther/meter/uid/reading", kind: "meter", stage: "metrics_retry", outcome: "metrics_retry_exhausted",
    reason_code: "METRICS_RETRY_EXHAUSTED", persisted: true, reading_id: 2, flock_cycle_id: 5,
    attempt: 3, retry_scheduled: false, retry_in_ms: 0,
  }, { name: "Error", code: "ER_LOCK_WAIT_TIMEOUT", stack: `Error: private\n${"    at recalculateCycle (private/path.js:3:4)\n".repeat(20)}` }, "error");
  assert.equal(messages[0].level, "error");
  assert.equal(messages[0].record.reason_code, "METRICS_RETRY_EXHAUSTED");
  assert.equal(messages[0].record.persisted, true);
  assert.equal(messages[0].record.stack_frames.length, 4);
  diagnostics.report({
    topic: "coasther/meter/uid/reading", kind: "meter", stage: "metrics_retry", outcome: "metrics_recovered",
    reason_code: "METRICS_REFRESH_RECOVERED", persisted: true, attempt: 2,
  }, null, "info");
  assert.equal(messages[1].level, "info");
  assert.equal(messages[1].record.outcome, "metrics_recovered");
});
