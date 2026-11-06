const { test } = require("node:test");
const assert = require("node:assert/strict");
const schema = require("../src/validators/phase5Monitoring.validator");
const history = require("../src/utils/telemetryHistory");
const guardSchema = require("../src/validators/guard.validator");
const { createEngine } = require("../src/services/guardEngine.service");

const now = new Date("2026-11-06T10:00:00Z");
const device = { id: 10, coop_id: 7 };

test("Phase5 history query is strict and bounded; arbitrary source, duration and query keys are rejected", () => {
  assert.deepEqual(schema.historyQuery.parse({}), { source: "real", minutes: 30, bucket_seconds: 30 });
  for (const input of [{ minutes: 121 }, { bucket_seconds: 1 }, { source: "sensor" }, { sql: "SELECT" }, { before: "2026-11-06T18:00:00" }]) assert.equal(schema.historyQuery.safeParse(input).success, false);
});

test("History captures original nullable scalars, accepted zero, independent source,5second slot and valid sensor/receipt clocks", () => {
  const sample = history.sampleInput(device, { power: 0, voltage: 220, recorded_at: now }, "simulation", now);
  assert.equal(sample.source, "simulation");
  assert.equal(sample.fields_json.power_w, 0);
  assert.equal(sample.fields_json.flow_rate_lpm, null);
  assert.equal(sample.quality_json.field_status.power_w, "recorded");
  assert.equal(sample.quality_json.field_status.flow_rate_lpm, "no_data");
  assert.equal(sample.sample_bucket.getTime() % 5000, 0);
  assert.equal(history.sampleInput(device, { power: 12, recorded_at: "invalid" }, "mqtt", now), null);
  assert.equal(history.sampleInput(device, { power: 12, recorded_at: new Date(now.getTime() + 300001) }, "mqtt", now), null);
  assert.equal(history.sampleInput(device, { power: 12, recorded_at: new Date(now.getTime() - 8 * 86400000) }, "mqtt", now), null);
});

test("History downsampling deduplicates devices, keeps gaps missing and refuses to sum competing panel snapshots", () => {
  const row = (id, seconds, fields) => ({ device_id: id, recorded_at: new Date(now.getTime() + seconds * 1000), received_at: now, fields_json: JSON.stringify(fields) });
  const samples = history.bucketSamples([row(1, 0, { power_w: 0 }), row(1, 5, { power_w: 25 }), row(1, 120, { power_w: 30 }), row(2, 121, { power_w: 40 })], 30);
  assert.equal(samples.length, 2);
  assert.equal(samples[0].power_w, 25);
  assert.equal(samples[0].flow_rate_lpm, null);
  assert.equal(samples[1].power_w, null);
  assert.equal(samples[1].field_status.power_w, "not_available");
});

const calibration = { type: "water", reference_value: 10, sensor_value: 10.2, unit: "L", instrument_id: "bucket-10L", method: "Independently marked measuring bucket", measured_at: now.toISOString(), source: "real" };
test("Calibration provenance, units and positive reference are required; caller cannot set verification/actor fields", () => {
  assert.equal(schema.calibrationSchema.safeParse(calibration).success, true);
  for (const changes of [{ unit: "W" }, { reference_value: 0 }, { instrument_id: "" }, { recorded_by: 1 }, { verification_state: "independently_verified" }, { source: "mock" }]) assert.equal(schema.calibrationSchema.safeParse({ ...calibration, ...changes }).success, false);
  const stats = history.calibrationSummary([{ ...calibration, verification_state: "manual_recorded" }]);
  assert.ok(Math.abs(stats[0].mean_error_pct - 2) < 0.00001);
  assert.equal(stats[0].physical_accuracy_confirmed, false);
});

test("Validation schema requires trusted packet evidence and physical onset rather than guessing metrics from heartbeat", () => {
  const base = { source: "real", instrument_id: "reference-1", method: "External sequence and receipt count", observed_start: now.toISOString(), observed_end: now.toISOString() };
  assert.equal(schema.evidenceSchema.safeParse({ ...base, kind: "packet_delivery", evidence: { reference: "Reference log", expected_packets: 100, received_packets: 99 } }).success, false);
  assert.equal(schema.evidenceSchema.safeParse({ ...base, kind: "packet_delivery", evidence: { reference: "Reference log", expected_packets: 100, received_packets: 99, trusted_sequence_reference: "signed packet sequence" } }).success, true);
  assert.equal(schema.evidenceSchema.safeParse({ ...base, kind: "guard_response", evidence: { reference: "External onset log", alert_id: 1 } }).success, false);
});

test("Maintenance whitelist rejects arbitrary MQTT commands/tokens, demands UUID+confirmation, and no publish capability exists", () => {
  const service = require("../src/services/phase5Monitoring.service");
  assert.equal(service.capabilities().maintenance, false);
  assert.equal(service.capabilities().state, "requires_hardware_acceptance");
  const input = { device_id: 1, command: "status", request_id: "cb96574c-8703-43eb-b0eb-5718ce9f8efb", confirmation: "MAINTENANCE ACCEPTED", reason: "Scheduled operator maintenance" };
  assert.equal(schema.maintenanceSchema.safeParse(input).success, true);
  for (const change of [{ command: "relay_on" }, { command: "status:raw-token" }, { topic: "broker/control" }, { confirmation: "yes" }, { request_id: "1" }]) assert.equal(schema.maintenanceSchema.safeParse({ ...input, ...change }).success, false);
});

test("Validation report stays insufficient without independently verified REAL external evidence", () => {
  const service = require("../src/services/phase5Monitoring.service");
  assert.equal(service.evidenceReport([]).telemetry_reliability.received_pct, null);
  const event = { id: 1, kind: "packet_delivery", source: "simulation", verification_state: "independently_verified", evidence_json: JSON.stringify({ expected_packets: 100, received_packets: 99 }) };
  assert.equal(service.evidenceReport([event]).telemetry_reliability.state, "insufficient_evidence");
  const accepted = service.evidenceReport([{ ...event, source: "real" }]);
  assert.equal(accepted.telemetry_reliability.observations[0].received_pct, 99);
  assert.equal(accepted.guard_response.response_seconds, null);
});

test("Independent calibration verification rejects self-attestation, source simulation and cross-coop writes", async (t) => {
  const service = require("../src/services/phase5Monitoring.service");
  const access = require("../src/services/access.service");
  const tables = require("../src/utils/phase5Schema");
  const db = require("../src/config/db");
  const model = require("../src/models/phase5Monitoring.model");
  const connection = { async beginTransaction() {}, async commit() {}, async rollback() {}, release() {} };
  t.mock.method(db, "getConnection", async () => connection);
  t.mock.method(access, "lockCoop", async () => ({}));
  t.mock.method(access, "requireCoop", async () => ({}));
  t.mock.method(tables, "requireTables", async () => {});
  const lookup = t.mock.method(model, "entry", async () => ({ recorded_by: 5, source: "real" }));
  const writes = t.mock.method(model, "verify", async () => {});
  await assert.rejects(service.verifyCalibration({ id: 5 }, 7, 1, { evidence_note: "Independent evidence" }), /another authorized person/);
  lookup.mock.mockImplementation(async () => ({ recorded_by: 6, source: "simulation" }));
  await assert.rejects(service.verifyCalibration({ id: 5 }, 7, 1, { evidence_note: "Independent evidence" }), /Simulation evidence/);
  lookup.mock.mockImplementation(async () => null);
  await assert.rejects(service.verifyCalibration({ id: 5 }, 7, 1, { evidence_note: "Independent evidence" }), /not found/);
  assert.equal(writes.mock.callCount(), 0);
});

function rule(code, parameters_json = {}) {
  return { id: 99, ...guardSchema.createSchema.parse({ coop_id: 7, rule_code: code, name: "Phase5 test rule", parameters_json, evaluation_window_sec: 10 }) };
}
function context(seconds, extra = {}) {
  const at = new Date(now.getTime() + seconds * 1000);
  return { coopId: 7, source: "rule", now: at, devices: [{ id: 10, is_active: 1 }], snapshot: { source: "sensor", device_id: 10, recorded_at: at, voltage_v: 190, power_w: 100, power_factor: 0.7 }, ...extra };
}

test("Voltage/PF rules enforce sustained valid samples, recovery hysteresis and load evidence", () => {
  const voltage = rule("voltage_abnormal");
  const engine = createEngine();
  assert.equal(engine.evaluateRule(voltage, context(0))[0].status, "insufficient_data");
  engine.evaluateRule(voltage, context(5));
  assert.equal(engine.evaluateRule(voltage, context(10))[0].status, "trigger");
  const pf = rule("low_power_factor");
  const pfEngine = createEngine();
  pfEngine.evaluateRule(pf, context(0)); pfEngine.evaluateRule(pf, context(5));
  assert.equal(pfEngine.evaluateRule(pf, context(10))[0].status, "trigger");
  const invalid = context(15); invalid.snapshot.power_w = 0;
  assert.equal(pfEngine.evaluateRule(pf, invalid)[0].reason, "power_factor_requires_valid_panel_load");
  assert.equal(guardSchema.createSchema.safeParse({ coop_id: 7, rule_code: "voltage_abnormal", name: "Invalid band", parameters_json: { min_voltage_v: 250, max_voltage_v: 230 } }).success, false);
});

test("Production reminders use farm-local calendar, missing evidence and explicit target date; never infer physical fault", () => {
  const daily = rule("daily_record_missing", { due_hour: 16 });
  const production = { cycle: { id: 62, planned_harvest_date: "2026-11-05" }, daily_records_available: true, recorded_today: false };
  assert.equal(createEngine().evaluateRule(daily, context(0, { production, timezone: "Asia/Makassar" }))[0].status, "trigger");
  assert.equal(createEngine().evaluateRule(daily, context(0, { production: { ...production, recorded_today: true } }))[0].status, "recovery");
  assert.equal(createEngine().evaluateRule(daily, context(0, { production: { ...production, daily_records_available: false } }))[0].status, "insufficient_data");
  assert.equal(createEngine().evaluateRule(rule("cycle_overdue"), context(0, { production }))[0].status, "trigger");
  assert.equal(guardSchema.createSchema.safeParse({ coop_id: 7, rule_code: "daily_record_missing", name: "Reminder", severity: "critical", parameters_json: {} }).success, false);
});
