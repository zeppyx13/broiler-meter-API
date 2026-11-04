const defaultLogger = require("../config/logger");

const allowed = {
  kind: new Set(["meter", "telemetry", "device_log", "control_status", "unknown"]),
  source: new Set(["mqtt", "simulation", "sensor", "http", "timeout"]),
  stage: new Set(["topic", "json", "validation", "timestamp", "mapping", "transaction", "tx_begin", "tx_lock",
    "heartbeat", "dedup", "cursor", "cycle_attribution", "classify", "insert", "update", "commit", "post_commit",
    "metrics_refresh", "metrics_retry", "socket_emit", "device_timeout", "mqtt_connect", "mqtt_subscribe",
    "parse_message", "parse_json", "validate_payload", "meter_lookup", "device_lookup", "coop_lock", "device_lock",
    "meter_lock", "farm_context", "timestamp_conflict", "insert_reading", "update_cursor", "unknown"]),
  outcome: new Set(["stored", "duplicate", "disabled", "unmapped", "invalid_mapping", "historical_telemetry",
    "diagnostic_ignored", "unknown_topic", "invalid_timestamp", "invalid_source", "invalid_payload", "processing_error",
    "metrics_deferred", "metrics_recovered", "metrics_retry_exhausted", "refresh_deferred", "refresh_recovered",
    "retry_scheduled", "retry_exhausted", "device_timeout", "subscription_failed", "connection_error", "unknown"]),
  reason_code: new Set(["JSON_PARSE_ERROR", "VALIDATION_ERROR", "INVALID_TOPIC", "INVALID_PAYLOAD", "PAYLOAD_TOO_LARGE",
    "INVALID_SOURCE", "INVALID_TIMESTAMP", "UNKNOWN_TOPIC", "UNMAPPED", "INVALID_MAPPING", "DIAGNOSTIC_IGNORED",
    "PROCESSING_ERROR", "DATABASE_ERROR", "METRICS_REFRESH_FAILED", "METRICS_REFRESH_DEFERRED", "METRICS_REFRESH_RECOVERED",
    "METRICS_REFRESH_RETRY_EXHAUSTED", "METRICS_RETRY_EXHAUSTED", "SOCKET_EMIT_FAILED", "DEVICE_TIMEOUT_CHECK_FAILED",
    "MQTT_CONNECTION_ERROR", "MQTT_SUBSCRIPTION_FAILED", "UNEXPECTED_ERROR"]),
};
const errorNames = new Set(["Error", "ZodError", "SyntaxError", "TypeError", "RangeError", "ReferenceError", "URIError", "AggregateError"]);
const errorCodes = new Set(["ER_DUP_ENTRY", "ER_NO_REFERENCED_ROW_2", "ER_ROW_IS_REFERENCED_2", "ER_LOCK_DEADLOCK",
  "ER_LOCK_WAIT_TIMEOUT", "ER_BAD_FIELD_ERROR", "ER_NO_SUCH_TABLE", "ER_DATA_TOO_LONG", "ER_WARN_DATA_OUT_OF_RANGE",
  "WARN_DATA_TRUNCATED", "ER_TRUNCATED_WRONG_VALUE", "ER_TRUNCATED_WRONG_VALUE_FOR_FIELD", "ER_PARSE_ERROR",
  "ER_CON_COUNT_ERROR", "ER_ACCESS_DENIED_ERROR", "ER_DBACCESS_DENIED_ERROR", "ER_BAD_DB_ERROR", "ECONNRESET",
  "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN", "PROTOCOL_CONNECTION_LOST",
  "PROTOCOL_SEQUENCE_TIMEOUT", "POOL_CLOSED", "ER_USER_LIMIT_REACHED", "ER_TOO_MANY_USER_CONNECTIONS"]);
const issueCodes = new Set(["invalid_type", "too_big", "too_small", "invalid_format", "not_multiple_of", "unrecognized_keys",
  "invalid_union", "invalid_key", "invalid_element", "invalid_value", "custom", "invalid_string", "invalid_date",
  "invalid_enum_value", "invalid_literal", "not_finite"]);
const schemaPaths = new Set(["reading_value", "recorded_at", "flow_rate_lpm", "water_total_liter", "voltage", "current",
  "power", "energy_kwh_total", "frequency", "pf", "ntp_synced"]);
const functionNames = new Set(["parseMessage", "handleMessage", "ingestReading", "ingestTelemetry", "refreshMetrics", "publish",
  "withTransaction", "lockCoop", "lockFarm", "lockDevice", "lockMeter", "farmContext", "meterByUid", "deviceByTopic",
  "duplicate", "cursor", "timestampConflict", "cycles", "historicalCycle", "classify", "insertReading", "updateCursor",
  "seen", "snapshot", "saveSnapshot", "checkDeviceStatus", "staleDevices", "markOffline", "recalculateForReading",
  "recalculateCycle", "cycleById", "dayReadings", "populationChanges", "upsert", "query", "execute", "getConnection",
  "beginTransaction", "commit", "rollback", "requestRefresh", "runRefresh", "processPending", "drain", "retry"]);

function safeTopic(topic) {
  if (typeof topic !== "string" || topic.length > 300) return "[unrecognized-topic]";
  return /^(?:coasther\/meter\/[A-Za-z0-9_.:-]{1,120}\/reading|coasther\/telemetry\/[A-Za-z0-9_.:-]{1,120}\/live|coasther\/device\/[A-Za-z0-9_.:-]{1,120}\/(?:log|control-status))$/.test(topic)
    ? topic : "[unrecognized-topic]";
}

function safeIssues(error) {
  if (!Array.isArray(error?.issues)) return [];
  return error.issues.slice(0, 8).map((issue) => ({
    path: Array.isArray(issue.path) ? issue.path.slice(0, 8).map((part) =>
      schemaPaths.has(part) ? part : Number.isSafeInteger(part) && part >= 0 && part <= 9999 ? part : "[redacted]").join(".") : "",
    code: issueCodes.has(issue.code) ? issue.code : "unknown",
  }));
}

function safeFrames(error) {
  if (typeof error?.stack !== "string") return [];
  return error.stack.slice(0, 8192).split("\n").slice(1, 33).flatMap((line) => {
    const name = /^\s+at (?:async )?([A-Za-z0-9_.$<>]+)(?: \(|$)/.exec(line)?.[1]?.split(".").pop();
    return functionNames.has(name) ? [name] : [];
  }).slice(0, 4);
}

function errorDetails(error) {
  if (!error || typeof error !== "object") return {};
  const name = errorNames.has(error.name) ? error.name : "Error";
  const details = { error_class: name, error_code: errorCodes.has(error.code) ? error.code
    : name === "ZodError" ? "VALIDATION_ERROR" : name === "SyntaxError" ? "JSON_PARSE_ERROR" : "UNEXPECTED_ERROR" };
  if (Number.isInteger(error.statusCode) && error.statusCode >= 400 && error.statusCode <= 599) details.status_code = error.statusCode;
  const issues = safeIssues(error);
  if (issues.length) details.issues = issues;
  const frames = safeFrames(error);
  if (frames.length) details.stack_frames = frames;
  return details;
}

function createDiagnostics({ logger = defaultLogger, now = Date.now, windowMs = 30000, maxKeys = 128 } = {}) {
  const buckets = new Map();
  const duration = Number.isFinite(windowMs) && windowMs > 0 ? windowMs : 30000;
  const maximum = Number.isInteger(maxKeys) && maxKeys > 0 ? Math.min(maxKeys, 128) : 128;

  function report(context = {}, error, level = "warn") {
    const input = context && typeof context === "object" ? context : {};
    const details = errorDetails(error);
    const record = { event: "broiler_mqtt_diagnostic", pid: process.pid, topic: safeTopic(input.topic) };
    for (const field of ["kind", "stage", "outcome", "source"]) {
      if (input[field] !== undefined) record[field] = allowed[field].has(input[field]) ? input[field] : "unknown";
    }
    record.reason_code = allowed.reason_code.has(input.reason_code) ? input.reason_code
      : details.error_class === "ZodError" ? "VALIDATION_ERROR" : details.error_class === "SyntaxError" ? "JSON_PARSE_ERROR"
        : details.error_code && details.error_code !== "UNEXPECTED_ERROR" ? "DATABASE_ERROR" : "UNEXPECTED_ERROR";
    for (const field of ["reading_id", "coop_id", "device_id", "meter_id", "flock_cycle_id"]) {
      const value = typeof input[field] === "number" ? input[field]
        : typeof input[field] === "string" && /^\d{1,16}$/.test(input[field]) ? Number(input[field]) : NaN;
      if (Number.isSafeInteger(value) && value > 0) record[field] = value;
    }
    for (const field of ["payload_bytes", "attempt", "retry_in_ms"]) {
      if (Number.isSafeInteger(input[field]) && input[field] >= 0) record[field] = Math.min(input[field], 268435455);
    }
    for (const field of ["retained", "persisted", "retry_scheduled"]) {
      if (typeof input[field] === "boolean") record[field] = input[field];
    }
    Object.assign(record, details);
    const selectedLevel = ["warn", "error", "info"].includes(level) ? level : "warn";
    const fingerprint = JSON.stringify([selectedLevel, record.topic, record.kind, record.stage, record.outcome,
      record.reason_code, record.error_code, record.issues]);
    const time = now();
    const previous = buckets.get(fingerprint);
    if (previous && time >= previous.emittedAt && time - previous.emittedAt < duration) {
      previous.suppressed++;
      return null;
    }
    if (!previous && buckets.size >= maximum) buckets.delete(buckets.keys().next().value);
    record.suppressed_count = previous?.suppressed || 0;
    buckets.set(fingerprint, { emittedAt: time, suppressed: 0 });
    logger[selectedLevel](JSON.stringify(record));
    return record;
  }

  return { report };
}

const diagnostics = createDiagnostics();
module.exports = { createDiagnostics, report: diagnostics.report };
