const model = require("../models/iotBroiler.model");
const access = require("./access.service");
const withTransaction = require("../utils/transaction");
const { localDate } = require("../utils/farmDate");
const { classify } = require("../utils/meterCounter");
const { parseMessage } = require("../validators/iotBroiler.validator");
const diagnostics = require("../utils/mqttDiagnostics");
const metricsRefresh = require("./mqttMetricsRefresh.service");
const phase3 = require("./broilerPhase3Runtime.service");
const inputHealth = require("../utils/iotInputHealth");
const { staleSeconds } = require("../utils/deviceStatus");
const monitoringHistory = require("./phase5Monitoring.service");

const measurementFields = {
  flow_rate_lpm: "flow_rate_lpm",
  water_total_liter: "water_total_liter",
  voltage: "voltage_v",
  current: "current_a",
  power: "power_w",
  energy_kwh_total: "energy_kwh_total",
  frequency: "frequency_hz",
  pf: "power_factor",
};

function historicalCycle(cycles, date, timezone) {
  const day = localDate(timezone, date);
  const candidates = cycles.filter(
    (cycle) =>
      cycle.placement_date <= day &&
      (!cycle.actual_harvest_date || day <= cycle.actual_harvest_date),
  );
  // Placement/harvest dates have no within-day time. Shared boundary days are ambiguous.
  return candidates.length === 1 ? candidates[0].id : null;
}

async function publish(io, event, payload) {
  if (io) await require("./broilerSocket.service").publish(io, event, payload);
}

async function ingestReading(
  key,
  payload,
  { source, receivedAt, io, heartbeat, context },
) {
  context.stage = "mapping";
  const mapping = await model.meterByUid(key);
  if (!mapping) return { outcome: "unmapped" };
  Object.assign(context, {
    coop_id: mapping.coop_id,
    device_id: mapping.device_id,
    meter_id: mapping.id,
  });
  context.stage = "tx_lock";
  const result = await withTransaction(async (connection) => {
    const coop = await access.lockCoop(connection, mapping.coop_id);
    const device = await model.lockDevice(mapping.device_id, connection);
    const meter = await model.lockMeter(mapping.id, connection);
    const farm = await model.farmContext(coop.farm_id, connection);
    if (
      !device.is_active ||
      !meter.is_active ||
      coop.status !== "active" ||
      !farm.is_active
    ) {
      return { outcome: "disabled" };
    }
    if (
      (meter.type === "water" && meter.unit !== "liter") ||
      (meter.type === "electricity" && meter.unit !== "kwh")
    ) {
      return { outcome: "invalid_mapping" };
    }
    context.stage = "heartbeat";
    const lastSeen =
      source !== "simulation" && heartbeat
        ? await model.seen(device.id, receivedAt, connection)
        : null;
    context.stage = "dedup";
    const duplicate = await model.duplicate(
      meter.id,
      payload.reading_value,
      payload.recorded_at,
      source,
      connection,
    );
    if (duplicate) {
      return {
        outcome: "duplicate",
        coop_id: device.coop_id,
        device_id: device.id,
        last_seen_at: lastSeen,
        flock_cycle_id: duplicate.flock_cycle_id,
        recorded_at: duplicate.recorded_at,
        timezone: farm.timezone,
        id: duplicate.id,
      };
    }
    context.stage = "cursor";
    const previous = await model.cursor(meter.id, source, connection);
    context.stage = "cycle_attribution";
    const cycleId = historicalCycle(
      await model.cycles(device.coop_id, connection),
      payload.recorded_at,
      farm.timezone,
    );
    context.stage = "timestamp_conflict";
    const conflict = await model.timestampConflict(
      meter.id,
      payload.recorded_at,
      source,
      connection,
    );
    const decision = conflict
      ? {
          reading_status: "suspect",
          delta_value: "0.000000",
          counter_epoch: Number(previous?.counter_epoch || 0),
          is_latest: false,
        }
      : classify(previous, payload.reading_value, payload.recorded_at, cycleId);
    const reading = {
      ...decision,
      meter_id: meter.id,
      device_id: device.id,
      coop_id: device.coop_id,
      meter_uid: meter.meter_uid,
      type: meter.type,
      unit: meter.unit,
      flock_cycle_id: cycleId,
      reading_value: payload.reading_value,
      recorded_at: payload.recorded_at,
      received_at: receivedAt,
      source,
      last_seen_at: lastSeen,
      timezone: farm.timezone,
    };
    context.flock_cycle_id = cycleId;
    context.stage = "insert";
    reading.id = await model.insertReading(reading, connection);
    context.stage = "update";
    if (decision.is_latest && source !== "simulation")
      await model.updateCursor(reading, connection);
    context.stage = "commit";
    return { outcome: "stored", ...reading };
  });
  context.stage = "post_commit";
  void phase3.enqueue(result, null, { io, source, receivedAt });
  if (result.outcome === "stored") {
    Object.assign(context, {
      persisted: true,
      reading_id: result.id,
      flock_cycle_id: result.flock_cycle_id,
    });
    result.metrics_refresh = await metricsRefresh.refresh(result, {
      ...context,
    });
    context.stage = "socket_emit";
    await publish(io, "meter_update", result);
  } else if (result.outcome === "duplicate") {
    // Replayed delivery can repair a previously failed cache without adding another raw reading.
    result.metrics_refresh = await metricsRefresh.refresh(result, {
      ...context,
      persisted: true,
      reading_id: result.id,
      flock_cycle_id: result.flock_cycle_id,
    });
  }
  if (result.last_seen_at && ["stored", "duplicate"].includes(result.outcome)) {
    context.stage = "socket_emit";
    await publish(io, "device_status", {
      device_id: result.device_id,
      coop_id: result.coop_id,
      connectivity_status: "online",
      last_seen_at: result.last_seen_at,
      observed_at: receivedAt,
      source: "mqtt",
      is_latest: true,
    });
  }
  return result;
}

function mergeSnapshot(existing, payload, device, source) {
  const sameSource = existing && existing.source === source;
  const old = sameSource ? existing : null;
  let metadata = {};
  try {
    metadata = old?.phase_data_json ? JSON.parse(old.phase_data_json) : {};
  } catch {
    /* historical metadata absent */
  }
  const times = metadata.metric_recorded_at || {};
  const origins = metadata.metric_device_id || {};
  const ambiguous = new Set(metadata.ambiguous_metrics || []);
  const result = {
    coop_id: device.coop_id,
    device_id: device.id,
    source,
    recorded_at: payload.recorded_at,
  };
  for (const [input, field] of Object.entries(measurementFields)) {
    result[field] = old?.[field] == null ? null : Number(old[field]);
    if (payload[input] === undefined) continue;
    const priorDevice = origins[field] ?? old?.device_id;
    if (
      priorDevice != null &&
      Number(priorDevice) !== Number(device.id) &&
      old?.[field] != null
    )
      ambiguous.add(field);
    result[field] = ambiguous.has(field) ? null : payload[input];
    times[field] = payload.recorded_at.toISOString();
    origins[field] = device.id;
  }
  result.phase_data_json = {
    metric_recorded_at: times,
    metric_device_id: origins,
    ambiguous_metrics: [...ambiguous],
    ntp_synced: payload.ntp_synced ?? null,
  };
  return result;
}

async function ingestTelemetry(
  key,
  payload,
  { source, receivedAt, io, heartbeat, context },
) {
  let historyCaptured = false;
  context.stage = "mapping";
  const mapping = await model.deviceByTopic(key);
  if (!mapping) return { outcome: "unmapped" };
  Object.assign(context, { coop_id: mapping.coop_id, device_id: mapping.id });
  context.stage = "tx_lock";
  const result = await withTransaction(async (connection) => {
    const coop = await access.lockCoop(connection, mapping.coop_id);
    const device = await model.lockDevice(mapping.id, connection);
    const farm = await model.farmContext(coop.farm_id, connection);
    if (!device.is_active || coop.status !== "active" || !farm.is_active) {
      return { outcome: "disabled" };
    }
    // The bounded instantaneous series is independent from the latest-snapshot cursor.
    // Old-but-valid samples may fill history, without overwriting live data or heartbeat.
    const historyResult = await monitoringHistory.capture(connection, device, payload, source, receivedAt);
    historyCaptured = historyResult.state === "stored";
    await monitoringHistory.captureDiagnostic(connection, device, "TELEMETRY_RECEIVED", source, receivedAt);
    context.stage = "heartbeat";
    const lastSeen =
      source !== "simulation" && heartbeat
        ? await model.seen(device.id, receivedAt, connection)
        : null;
    context.stage = "cursor";
    const existing = await model.snapshot(device.coop_id, connection);
    const snapshotSource = source === "simulation" ? "simulation" : "sensor";
    const newer =
      (existing?.source === "simulation" && snapshotSource === "sensor") ||
      !existing?.recorded_at ||
      payload.recorded_at.getTime() > new Date(existing.recorded_at).getTime();
    const allowedSource = !(
      snapshotSource === "simulation" && existing?.source === "sensor"
    );
    if (!newer || !allowedSource)
      return {
        outcome: "historical_telemetry",
        device_id: device.id,
        coop_id: device.coop_id,
        is_latest: false,
        recorded_at: payload.recorded_at,
        received_at: receivedAt,
        source: snapshotSource,
        last_seen_at: lastSeen,
      };
    const snapshot = mergeSnapshot(existing, payload, device, snapshotSource);
    context.stage = "update";
    await model.saveSnapshot(snapshot, connection);
    context.stage = "commit";
    return {
      outcome: "stored",
      device_id: device.id,
      coop_id: device.coop_id,
      snapshot,
      is_latest: true,
      recorded_at: payload.recorded_at,
      received_at: receivedAt,
      source: snapshotSource,
      last_seen_at: lastSeen,
    };
  });
  if (historyCaptured) await monitoringHistory.pruneIfDue(receivedAt);
  void phase3.enqueue(result, payload, { io, source, receivedAt });
  if (result.outcome === "stored") {
    context.persisted = true;
    context.stage = "socket_emit";
    await publish(io, "telemetry_update", result);
  }
  if (
    result.last_seen_at &&
    ["stored", "historical_telemetry"].includes(result.outcome)
  ) {
    context.stage = "socket_emit";
    await publish(io, "device_status", {
      device_id: result.device_id,
      coop_id: result.coop_id,
      connectivity_status: "online",
      last_seen_at: result.last_seen_at,
      observed_at: receivedAt,
      source: "mqtt",
      is_latest: true,
    });
  }
  return result;
}

async function handleMessage(
  topic,
  message,
  {
    source = "mqtt",
    receivedAt = new Date(),
    io,
    heartbeat = true,
    retained = false,
  } = {},
) {
  const parts = typeof topic === "string" ? topic.split("/") : [];
  const kind =
    parts[1] === "device"
      ? parts[3] === "log"
        ? "device_log"
        : "control_status"
      : ["meter", "telemetry"].includes(parts[1])
        ? parts[1]
        : "unknown";
  const context = {
    topic,
    kind,
    source,
    retained,
    stage: "topic",
    payload_bytes: Buffer.isBuffer(message)
      ? message.length
      : typeof message === "string"
        ? Buffer.byteLength(message)
        : 0,
  };
  try {
    if (!["mqtt", "simulation"].includes(source))
      return { outcome: "invalid_source" };
    context.stage = "json";
    const parsed = parseMessage(topic, message);
    if (!parsed) return { outcome: "unknown_topic" };
    // Raw diagnostic payloads can contain Wi-Fi credentials or command tokens. Do not persist or forward them.
    if (parsed.kind === "diagnostic") return { outcome: "diagnostic_ignored" };
    if (parsed.kind === "control_status") {
      context.stage = "relay_observation";
      return await require("./relayBroiler.service").observeControlStatus(
        parsed.key,
        parsed.payload,
        { io, source, receivedAt, retained },
      );
    }
    context.stage = "timestamp";
    if (
      parsed.payload.recorded_at.getTime() > receivedAt.getTime() + 300000 ||
      parsed.payload.recorded_at.getUTCFullYear() < 2000
    ) {
      if (parsed.kind === "telemetry" && source === "mqtt" && !retained)
        inputHealth.recordInvalidTimestamp(parsed.key, receivedAt);
      diagnostics.report({
        ...context,
        outcome: "invalid_timestamp",
        reason_code: "INVALID_TIMESTAMP",
      });
      return { outcome: "invalid_timestamp" };
    }
    if (parsed.kind === "telemetry" && source === "mqtt" && !retained)
      inputHealth.clear(parsed.key);
    const result = await (
      parsed.kind === "meter" ? ingestReading : ingestTelemetry
    )(parsed.key, parsed.payload, {
      source,
      receivedAt,
      io,
      heartbeat,
      context,
    });
    if (result.outcome === "unmapped")
      diagnostics.report({
        ...context,
        outcome: "unmapped",
        reason_code: "UNMAPPED",
      });
    return result;
  } catch (error) {
    if (
      kind === "telemetry" &&
      source === "mqtt" &&
      !retained &&
      error.name === "ZodError" &&
      error.issues?.some((issue) => issue.path?.[0] === "recorded_at")
    ) {
      inputHealth.recordInvalidTimestamp(parts[2], receivedAt);
    }
    // Never echo raw payload, identifiers from untrusted input, connection credentials or error SQL values.
    const outcome =
      error.name === "ZodError" ||
      error instanceof SyntaxError ||
      ["payload_too_large", "invalid_topic"].includes(error.message)
        ? "invalid_payload"
        : "processing_error";
    if (error.name === "ZodError") context.stage = "validation";
    else if (error instanceof SyntaxError) context.stage = "json";
    diagnostics.report(
      {
        ...context,
        outcome,
        reason_code:
          outcome === "invalid_payload"
            ? error.name === "ZodError"
              ? "VALIDATION_ERROR"
              : error instanceof SyntaxError
                ? "JSON_PARSE_ERROR"
                : "INVALID_PAYLOAD"
            : context.stage === "socket_emit"
              ? "SOCKET_EMIT_FAILED"
              : "PROCESSING_ERROR",
      },
      error,
    );
    return { outcome };
  }
}

async function checkDeviceStatus(io, now = new Date()) {
  const cutoff = new Date(now.getTime() - staleSeconds() * 1000);
  let changed = 0;
  for (const device of await model.staleDevices(cutoff)) {
    if (!(await model.markOffline(device.id, cutoff))) continue;
    changed++;
    await publish(io, "device_status", {
      coop_id: device.coop_id,
      device_id: device.id,
      connectivity_status: "offline",
      last_seen_at: device.last_seen_at,
      observed_at: now,
      source: "timeout",
      is_latest: true,
    });
  }
  return changed;
}

module.exports = {
  handleMessage,
  historicalCycle,
  mergeSnapshot,
  checkDeviceStatus,
};
