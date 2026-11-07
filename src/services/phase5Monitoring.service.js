const db = require("../config/db");
const access = require("./access.service");
const model = require("../models/phase5Monitoring.model");
const schema = require("../utils/phase5Schema");
const withTransaction = require("../utils/transaction");
const httpError = require("../utils/httpError");
const history = require("../utils/telemetryHistory");
const { commands } = require("../validators/phase5Monitoring.validator");

let lastPruneAt = 0;
let pruning = false;
const diagnosticRates = new Map();

function capabilities() {
  return {
    status_read: true,
    status_transport: "rest",
    commands_supported: commands,
    capability_endpoint: "/api/coops/:id/maintenance/status",
    physical_state_confirmed: false,
    explanation:
      "Read per-device command_capabilities from the passive status endpoint; each POST is revalidated by the server.",
  };
}

const maintenanceStatus = (...args) =>
  require("./maintenanceBroiler.service").status(...args);

// Optional additive storage must never make an un-migrated Phase1–4 ingest fail.
async function capture(connection, device, payload, source, receivedAt) {
  if (typeof connection.query !== "function") return { state: "not_available" };
  const input = history.sampleInput(device, payload, source, receivedAt);
  if (!input) return { state: "outside_retention_or_invalid_timestamp" };
  try {
    const stored = await model.insertSample(connection, input);
    return {
      state: stored ? "stored" : "duplicate_bucket",
      resolution_seconds: 5,
    };
  } catch (error) {
    if (error.code === "ER_NO_SUCH_TABLE")
      return { state: "migration_required" };
    throw error;
  }
}

async function pruneIfDue(now = new Date()) {
  if (pruning || now.getTime() - lastPruneAt < 60000) return;
  pruning = true;
  try {
    // Run after commit, without parent locks: global buffer retention cannot deadlock ingest writers.
    await model.prune(
      db,
      new Date(now.getTime() - history.retentionHours() * 3600000),
    );
    lastPruneAt = now.getTime();
  } catch (error) {
    if (error.code !== "ER_NO_SUCH_TABLE")
      require("../utils/mqttDiagnostics").report(
        {
          stage: "post_commit",
          outcome: "processing_error",
          reason_code: "DATABASE_ERROR",
        },
        error,
      );
  } finally {
    pruning = false;
  }
}

async function captureDiagnostic(connection, device, code, source, receivedAt) {
  if (typeof connection.query !== "function") return;
  const now = new Date(receivedAt).getTime();
  const key = `${device.id}:${source}:${code}`;
  if (now - (diagnosticRates.get(key) || 0) < 30000) return;
  if (diagnosticRates.size >= 1024 && !diagnosticRates.has(key))
    diagnosticRates.delete(diagnosticRates.keys().next().value);
  const allowed = {
    TELEMETRY_RECEIVED: [
      "info",
      "Validated telemetry received; scalar provenance is available in telemetry history",
    ],
    DEVICE_LOG_WITHHELD: [
      "info",
      "Device diagnostic received; raw text is withheld to protect credentials",
    ],
    INVALID_TIMESTAMP: [
      "warning",
      "Telemetry timestamp was rejected; trusted heartbeat was not updated",
    ],
    MAINTENANCE_BLOCKED: [
      "warning",
      "Physical maintenance request audited but not published: firmware correlation, anti-replay and operator acceptance are required",
    ],
    RELAY_COMMAND_INVALID_TOKEN: [
      "error",
      "Device reported an invalid command token; operator must reconcile backend and firmware configuration. This observation is not a correlated command acknowledgement",
    ],
    RELAY_COMMAND_INVALID_FORMAT: [
      "error",
      "Device rejected a command format; no correlated command acknowledgement is available",
    ],
    RELAY_ON_OBSERVED: [
      "info",
      "Device reported relay ON; this is an observation, not correlated command acknowledgement or physical load confirmation",
    ],
    RELAY_OFF_OBSERVED: [
      "info",
      "Device reported relay OFF; this is an observation, not correlated command acknowledgement or physical load confirmation",
    ],
  };
  if (!allowed[code]) return;
  try {
    const [level, message] = allowed[code];
    await model.diagnostic(connection, {
      coop_id: device.coop_id,
      device_id: device.id,
      level,
      code,
      message,
      source: source === "simulation" ? "simulation" : "real",
      recorded_at: receivedAt,
      received_at: receivedAt,
    });
    diagnosticRates.set(key, now);
  } catch (error) {
    if (error.code !== "ER_NO_SUCH_TABLE") throw error;
  }
}

async function telemetryHistory(user, coopId, query, now = new Date()) {
  await access.requireCoop(user, coopId);
  await schema.requireTables(db, ["telemetry_samples"]);
  const to = query.before ? new Date(query.before) : now;
  if (to > now) throw httpError(400, "History end may not be in the future");
  const from = new Date(to.getTime() - query.minutes * 60000);
  const rows = await model.history(coopId, query.source, from, to);
  return {
    coop_id: coopId,
    source: query.source,
    is_simulated: query.source === "simulation",
    samples: history.bucketSamples(rows, query.bucket_seconds),
    state: rows.length ? "ready" : "no_data",
    quality: rows.length ? "partial" : "no_data",
    interval: {
      from: from.toISOString(),
      to: to.toISOString(),
      bucket_seconds: query.bucket_seconds,
    },
    generated_at: now.toISOString(),
    retention_hours: history.retentionHours(),
    limitations: [
      "Only observed instantaneous samples are shown; gaps are not filled with zero",
      "Sampling coverage is not verified",
      "Tank inlet and aggregate panel measurements do not identify individual appliances",
    ],
  };
}

async function diagnostics(user, coopId, query) {
  await access.requireCoop(user, coopId);
  await schema.requireTables(db, ["device_diagnostic_entries"]);
  const entries = await model.diagnostics(coopId, query);
  return {
    coop_id: coopId,
    source: query.source,
    entries,
    capabilities: capabilities(),
    next_before_id: entries.length === query.limit ? entries.at(-1).id : null,
  };
}

async function withCoop(user, coopId, capability, tables, work) {
  return withTransaction(async (connection) => {
    await access.lockCoop(connection, coopId);
    const coop = await access.requireCoop(user, coopId, capability, connection);
    await schema.requireTables(connection, tables);
    return work(connection, coop);
  });
}

function notFuture(input, now = new Date()) {
  if (Date.parse(input) > now.getTime() + 300000)
    throw httpError(400, "Evidence timestamp may not be in the future");
}

function calibration(row) {
  return {
    ...row,
    reference_value: Number(row.reference_value),
    sensor_value: Number(row.sensor_value),
    error_pct:
      (Math.abs(Number(row.sensor_value) - Number(row.reference_value)) /
        Number(row.reference_value)) *
      100,
    physical_accuracy_confirmed: false,
  };
}

async function listCalibrations(user, coopId, query) {
  await access.requireCoop(user, coopId);
  await schema.requireTables(db, ["sensor_calibrations"]);
  const rows = await model.calibrations(coopId, query);
  return {
    coop_id: coopId,
    source: query.source,
    calibrations: rows.map(calibration),
    next_before_id: rows.length === query.limit ? rows.at(-1).id : null,
  };
}

async function createCalibration(user, coopId, input) {
  notFuture(input.measured_at);
  return withCoop(
    user,
    coopId,
    "operate",
    ["sensor_calibrations"],
    async (connection) => {
      if (input.device_id) {
        const device = await model.device(input.device_id, connection);
        if (!device || Number(device.coop_id) !== Number(coopId))
          throw httpError(404, "Calibration device not found in this coop");
      }
      const id = await model.createCalibration(
        connection,
        coopId,
        user.id,
        input,
      );
      return {
        calibration: calibration(
          await model.entry(connection, "sensor_calibrations", coopId, id),
        ),
      };
    },
  );
}

async function verify(user, coopId, entryId, input, table) {
  return withCoop(user, coopId, "manage", [table], async (connection) => {
    const row = await model.entry(connection, table, coopId, entryId, true);
    if (!row) throw httpError(404, "Evidence not found in this coop");
    if (Number(row.recorded_by) === Number(user.id))
      throw httpError(
        409,
        "Independent verification requires another authorized person",
      );
    if (row.source === "simulation")
      throw httpError(
        409,
        "Simulation evidence cannot be verified as a physical measurement",
      );
    await model.verify(
      connection,
      table,
      entryId,
      user.id,
      input.evidence_note,
      new Date(),
    );
    const verified = await model.entry(connection, table, coopId, entryId);
    return table === "sensor_calibrations"
      ? { calibration: calibration(verified) }
      : { evidence: presentEvidence(verified) };
  });
}

function presentEvidence(row) {
  const { evidence_json, ...safe } = row;
  return {
    ...safe,
    evidence: history.json(evidence_json),
    physical_validation_automatically_confirmed: false,
  };
}

async function listEvidence(user, coopId, query) {
  await access.requireCoop(user, coopId);
  await schema.requireTables(db, ["field_validation_events"]);
  const rows = await model.evidence(coopId, query);
  return {
    coop_id: coopId,
    source: query.source,
    entries: rows.map(presentEvidence),
    next_before_id: rows.length === query.limit ? rows.at(-1).id : null,
  };
}

async function createEvidence(user, coopId, input) {
  notFuture(input.observed_end);
  return withCoop(
    user,
    coopId,
    "operate",
    ["field_validation_events"],
    async (connection) => {
      if (input.kind === "guard_response") {
        const alert = await model.alert(
          coopId,
          input.evidence.alert_id,
          connection,
        );
        if (
          !alert ||
          (alert.source === "simulation") !== (input.source === "simulation")
        )
          throw httpError(
            404,
            "Evidence alert not found in this source and coop",
          );
        const actual = new Date(alert.detected_at).getTime();
        if (Math.abs(actual - Date.parse(input.evidence.detection_at)) > 1000)
          throw httpError(
            409,
            "Detection time must match the stored alert timestamp",
          );
      }
      const id = await model.createEvidence(connection, coopId, user.id, input);
      return {
        evidence: presentEvidence(
          await model.entry(connection, "field_validation_events", coopId, id),
        ),
      };
    },
  );
}

function evidenceReport(rows) {
  const verified = rows.filter(
    (row) =>
      row.source === "real" &&
      row.verification_state === "independently_verified",
  );
  const delivery = verified
    .filter((row) => row.kind === "packet_delivery")
    .map((row) => ({ id: row.id, ...history.json(row.evidence_json) }));
  const guard = verified
    .filter((row) => row.kind === "guard_response")
    .map((row) => ({ id: row.id, ...history.json(row.evidence_json) }));
  return {
    telemetry_reliability: delivery.length
      ? {
          state: "independently_attested",
          observations: delivery.map((v) => ({
            evidence_id: v.id,
            received_packets: v.received_packets,
            expected_packets: v.expected_packets,
            received_pct: (100 * v.received_packets) / v.expected_packets,
          })),
        }
      : {
          state: "insufficient_evidence",
          received_pct: null,
          reason:
            "Trusted packet sequence and independently verified instrument evidence are required; heartbeat frequency is not packet delivery",
        },
    guard_response: guard.length
      ? {
          state: "independently_attested",
          observations: guard.map((v) => ({
            evidence_id: v.id,
            alert_id: v.alert_id,
            response_seconds:
              (Date.parse(v.detection_at) - Date.parse(v.physical_onset_at)) /
              1000,
          })),
        }
      : {
          state: "insufficient_evidence",
          response_seconds: null,
          reason:
            "A separately observed physical onset and independently verified timestamps are required",
        },
  };
}

async function validationReport(user, coopId, query) {
  await access.requireCoop(user, coopId);
  await schema.requireTables(db, [
    "sensor_calibrations",
    "field_validation_events",
  ]);
  const [calibrations, entries] = await Promise.all([
    model.calibrations(coopId, { source: query.source, limit: 100 }),
    model.evidence(coopId, { source: query.source, limit: 100 }),
  ]);
  return {
    coop_id: coopId,
    source: query.source,
    state:
      calibrations.length || entries.length
        ? "manual_evidence_available"
        : "not_verified",
    calibrations: history.calibrationSummary(calibrations),
    evidence: entries.map(presentEvidence),
    ...evidenceReport(entries),
    limitations: [
      "Instrument observations are manually recorded and must be reviewed by operators",
      "Simulation is never proof of physical accuracy, packet delivery, or prevented mortality",
    ],
  };
}

const maintenance = (...args) =>
  require("./maintenanceBroiler.service").submit(...args);

module.exports = {
  capture,
  pruneIfDue,
  captureDiagnostic,
  telemetryHistory,
  diagnostics,
  listCalibrations,
  createCalibration,
  verifyCalibration: (user, coopId, id, input) =>
    verify(user, coopId, id, input, "sensor_calibrations"),
  listEvidence,
  createEvidence,
  verifyEvidence: (user, coopId, id, input) =>
    verify(user, coopId, id, input, "field_validation_events"),
  validationReport,
  maintenance,
  maintenanceStatus,
  capabilities,
  evidenceReport,
};
