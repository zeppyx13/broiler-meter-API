const crypto = require("node:crypto");
const db = require("../config/db");
const model = require("../models/maintenanceBroiler.model");
const devices = require("../models/device.model");
const access = require("./access.service");
const schema = require("../utils/phase5Schema");
const withTransaction = require("../utils/transaction");
const httpError = require("../utils/httpError");
const { staleSeconds, presentDevice } = require("../utils/deviceStatus");
const inputHealth = require("../utils/iotInputHealth");
const { commands } = require("../validators/phase5Monitoring.validator");

const tables = [
  "maintenance_requests",
  "maintenance_request_details",
  "maintenance_acceptance_events",
];
const pendingStates = ["accepted", "publishing", "published", "observed"];
const timeoutMs = 45000;
const cooldownMs = {
  status: 10000,
  sync_ntp: 30000,
  reboot: 120000,
  clear_buf: 120000,
  reset_nvs: 120000,
};
const proof = {
  executed: false,
  actions_executed: false,
  broker_receipt_confirmed: false,
  device_acknowledged: false,
  physical_state_confirmed: false,
};
let publisher = null;
let sockets = null;
let checkingTimeouts = false;

function configure({ client = null, io = null } = {}) {
  publisher = client;
  sockets = io;
}
function hash(value) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}
function fingerprint(device) {
  return hash([
    device.id,
    device.coop_id,
    device.device_uid,
    device.mqtt_topic_key,
    device.device_type,
    device.firmware_version,
  ]);
}
function json(value) {
  try {
    return typeof value === "string" ? JSON.parse(value) : value || null;
  } catch {
    return null;
  }
}
function safeText(value, limit = 1000) {
  // Do not accept a command token copied into an audit reason/evidence field.
  const token = process.env.MQTT_CMD_TOKEN;
  return typeof value === "string"
    ? (token ? value.split(token).join("[REDACTED]") : value).slice(0, limit)
    : value;
}
function publicAcceptance(row, device) {
  if (!row) return null;
  const matching =
    row.target_fingerprint === fingerprint(device) &&
    Number(row.coop_id) === Number(device.coop_id);
  return {
    accepted: Number(row.accepted) === 1 && matching,
    binding_matches: matching,
    actor_id: row.actor_id,
    recorded_at: row.recorded_at,
    evidence_reference: row.evidence_reference,
  };
}
function present(row) {
  return {
    id: row.id,
    request_id: row.request_id,
    coop_id: row.coop_id,
    device_id: row.device_id,
    command: row.command,
    requested_by: row.requested_by,
    requested_at: row.requested_at,
    reason: row.reason,
    status: row.status,
    accepted_at: row.accepted_at,
    publish_attempted_at: row.publish_attempted_at,
    published_at: row.published_at,
    timeout_at: row.timeout_at,
    completed_at: row.completed_at,
    failure_reason: row.failure_reason,
    preflight: json(row.preflight_json),
    observation: json(row.observation_json),
    pending: pendingStates.includes(row.status),
    transport: "mqtt_qos0_nonretained",
    publication_semantics:
      "QoS0 callback is transport only; observations have no request correlation. Never retry automatically.",
    ...proof,
  };
}
async function storageAvailable(connection = db) {
  for (const table of tables)
    if (!(await schema.tableAvailable(connection, table))) return false;
  return true;
}
function requireStorage(available) {
  if (!available)
    throw Object.assign(httpError(503, "maintenance_migration_required"), {
      code: "maintenance_migration_required",
    });
}
async function currentActor(user, connection) {
  const actor = await model.actor(user.id, connection);
  if (!actor || !["admin", "manager", "operator"].includes(actor.role))
    throw httpError(403, "Maintenance authorization revoked");
  return actor;
}
function requirements(command) {
  const common = [
    "Hak owner farm atau admin dari server",
    "Source REAL dan binding device/coop aktif",
    "ESP32 v3.1 terdaftar; versi/binding diverifikasi operator",
    "Heartbeat receipt trusted fresh, health valid, broker tersambung",
    "Tidak ada command pending; cooldown perangkat telah lewat",
    "Hasil tidak memiliki ACK berkorelasi dan tidak dikirim ulang otomatis",
  ];
  if (command === "reboot")
    common.push(
      "Konfirmasi reboot; koneksi perangkat terputus sementara",
    );
  if (command === "clear_buf")
    common.push(
      "Backup buffer lengkap terverifikasi, identitas/count buffer dan prosedur rekonsiliasi kehilangan data; firmware v3.1 belum menyediakan kontrak ini",
    );
  if (command === "reset_nvs")
    common.push(
      "Backup counter/epoch terpercaya, rekonsiliasi air/energi dan reset PZEM terverifikasi; firmware v3.1 belum menyediakan kontrak ini",
    );
  return common;
}
async function capability(
  user,
  coop,
  device,
  command,
  source,
  connection,
  available,
  { ignoreRequestId = null, now = new Date() } = {},
) {
  const base = {
    allowed: false,
    reason: "unknown",
    explanation: "",
    prerequisites: requirements(command),
    command,
    device_id: device.id,
    software_supported: true,
    correlated_ack_supported: false,
  };
  const deny = (reason, explanation, httpStatus = 409) => ({
    ...base,
    reason,
    explanation,
    http_status: httpStatus,
  });
  if (user.role !== "admin" && coop.member_role !== "owner")
    return deny(
      "capability_denied",
      "Maintenance memerlukan owner farm atau admin dalam cakupan perangkat ini.",
      403,
    );
  if (source !== "real")
    return deny(
      "simulation_read_only",
      "Source SIM tidak boleh mengeksekusi perangkat fisik.",
    );
  const provenance =
    device.data_provenance ||
    (await devices.findById(device.id, connection))?.data_provenance;
  if (provenance === "simulation")
    return deny(
      "non_physical_target",
      "Registry ini hanya memiliki bukti data historis internal, bukan perangkat REAL.",
    );
  if (command === "clear_buf")
    return deny(
      "buffer_backup_protocol_required",
      "Tidak tersedia: perlu perlindungan data perangkat. Firmware v3.1 belum menyediakan inventaris/backup buffer dan rekonsiliasi data yang belum terkirim.",
    );
  if (command === "reset_nvs")
    return deny(
      "counter_epoch_reconciliation_required",
      "Tidak tersedia: perlu perlindungan data perangkat. Firmware v3.1 belum menyediakan backup counter/epoch dan rekonsiliasi reset air serta PZEM.",
    );
  if (!available)
    return deny(
      "maintenance_migration_required",
      "Operator perlu meninjau backup dan menerapkan migrasi additive 007 secara terpisah; belum ada perubahan database aktif.",
      503,
    );
  if (!device.is_active || coop.status !== "active" || !coop.farm_is_active)
    return deny(
      "inactive_target",
      "Aktifkan perangkat, kandang dan farm melalui pengelolaan resmi.",
    );
  if (!/^[A-Za-z0-9_.:-]{1,120}$/.test(device.mqtt_topic_key || ""))
    return deny(
      "invalid_device_binding",
      "Mapping topic perangkat terdaftar tidak valid; perbaiki registrasi perangkat.",
    );
  if (
    device.device_type !== "esp32" ||
    !["3.1", "v3.1"].includes(device.firmware_version)
  )
    return deny(
      "unsupported_firmware",
      "Daftarkan ESP32 firmware v3.1 yang telah diverifikasi operator; versi tidak disimpulkan dari telemetry.",
    );
  const seen = device.last_seen_at
    ? new Date(device.last_seen_at).getTime()
    : NaN;
  if (
    !Number.isFinite(seen) ||
    now.getTime() - seen > staleSeconds() * 1000 ||
    seen > now.getTime()
  )
    return deny(
      "heartbeat_stale",
      "Tunggu heartbeat REAL nonretained dengan trusted receipt terbaru; timestamp dari perangkat bukan bukti koneksi.",
    );
  if (inputHealth.recentInvalidTimestamp(device.mqtt_topic_key, now))
    return deny(
      "device_clock_unhealthy",
      "Telemetry terbaru mempunyai timestamp invalid; pulihkan clock/prosedur perangkat sampai data valid diterima.",
    );
  const pending = await model.pending(device.id, connection);
  if (pending && pending.id !== ignoreRequestId)
    return deny(
      "command_pending",
      "Permintaan maintenance perangkat masih pending; baca status request dan jangan kirim ulang.",
    );
  if (await model.relayPending(device.id, connection))
    return deny(
      "relay_command_pending",
      "Command relay perangkat masih pending; tunggu timeout/status sebelum maintenance.",
    );
  const previous = await model.latest(device.id, connection);
  if (
    previous &&
    previous.id !== ignoreRequestId &&
    now.getTime() - new Date(previous.accepted_at).getTime() <
      cooldownMs[previous.command]
  )
    return deny(
      "command_cooldown",
      "Tunggu cooldown server perangkat, termasuk 120 detik setelah permintaan reboot.",
      429,
    );
  if (
    !publisher?.connected ||
    publisher.disconnecting ||
    publisher.reconnecting
  )
    return deny(
      "broker_not_connected",
      "Broker MQTT backend belum siap; tidak ada antrean command untuk reconnect.",
      503,
    );
  if (publisher.options?.queueQoSZero !== false)
    return deny(
      "offline_queue_not_disabled",
      "Backend harus menonaktifkan queueQoSZero sebelum maintenance dapat digunakan.",
      503,
    );
  const token = process.env.MQTT_CMD_TOKEN;
  if (
    typeof token !== "string" ||
    !token.length ||
    token !== token.trim() ||
    /[\r\n\0]/.test(token)
  )
    return deny(
      "command_token_not_configured",
      "Token command privat backend belum dikonfigurasi dengan benar; jangan masukkan token ke browser.",
      503,
    );
  return {
    ...base,
    allowed: true,
    reason: "ready",
    explanation:
      "Prasyarat server terpenuhi. Publish tidak membuktikan command dijalankan; verifikasi fisik tetap oleh operator.",
    http_status: 202,
  };
}

async function status(user, coopId, { source = "real" } = {}) {
  const coop = await access.requireCoop(user, coopId);
  const available = await storageAvailable();
  const rows = (await model.devices(coopId)).filter(
    (device) => device.data_provenance !== "simulation",
  );
  const now = new Date();
  const result = [];
  for (const row of rows.slice(0, 100)) {
    if (available) await expireScoped(user, coopId, row.id, now);
    const command_capabilities = {};
    for (const command of commands)
      command_capabilities[command] = await capability(
        user,
        coop,
        row,
        command,
        source,
        db,
        available,
        { now },
      );
    const { mqtt_topic_key, ...safe } = row;
    result.push({ ...presentDevice(safe, now), command_capabilities });
  }
  const recent = available ? await model.recent(coopId) : [];
  const relays = await require("../models/relayBroiler.model").list(user, {
    coop_id: coopId,
    page: 1,
    limit: 100,
  });
  const aggregate = Object.fromEntries(
    commands.map((command) => [
      command,
      result.find((d) => d.command_capabilities[command].allowed)
        ?.command_capabilities[command] ||
        result[0]?.command_capabilities[command] || {
          allowed: false,
          reason: "no_devices",
          explanation: "Daftarkan perangkat pada kandang ini.",
          prerequisites: requirements(command),
        },
    ]),
  );
  return {
    coop_id: coopId,
    source,
    state: result.length ? "observed" : "no_devices",
    devices: result,
    relays: relays.map((row) =>
      require("./relayBroiler.service").present(row, now),
    ),
    recent_requests: recent.map(present),
    truncated: rows.length > 100 || relays.length === 100,
    capabilities: {
      commands: aggregate,
      status_read: true,
      status_transport: "rest",
      schema_ready: available,
    },
    generated_at: now.toISOString(),
    ...proof,
    status_semantics:
      "Passive stored REST snapshot only; GET never publishes MQTT or confirms physical execution.",
  };
}
async function expireScoped(user, coopId, deviceId, now) {
  return withTransaction(async (connection) => {
    await access.lockCoop(connection, coopId);
    await access.requireCoop(user, coopId, "read", connection);
    const device = await devices.lockById(deviceId, connection);
    if (device && Number(device.coop_id) === Number(coopId))
      await model.expireDevice(deviceId, now, connection);
  });
}
async function requestStatus(user, coopId, requestId) {
  await access.requireCoop(user, coopId);
  requireStorage(await storageAvailable());
  const row = await model.byUuid(user.id, requestId);
  if (!row || Number(row.coop_id) !== Number(coopId))
    throw httpError(404, "Maintenance request not found");
  await expireScoped(user, coopId, row.device_id, new Date());
  return { request: present(await model.byId(row.id)), ...proof };
}
async function acceptance(user, coopId, input) {
  await access.requireCoop(user, coopId, "owner");
  requireStorage(await storageAvailable());
  const clean = {
    ...input,
    evidence_reference: safeText(input.evidence_reference, 255),
    note: safeText(input.note),
  };
  const payloadHash = hash([coopId, input]);
  return withTransaction(async (connection) => {
    await access.lockCoop(connection, coopId);
    await access.requireCoop(
      await currentActor(user, connection),
      coopId,
      "owner",
      connection,
    );
    const device = await devices.lockById(input.device_id, connection);
    if (!device || Number(device.coop_id) !== Number(coopId))
      throw httpError(404, "Device not found in this coop");
    const previous = await model.acceptanceReplay(
      user.id,
      input.request_id,
      connection,
    );
    if (previous) {
      if (previous.payload_hash !== payloadHash)
        throw httpError(
          409,
          "request_id already used for different acceptance payload",
        );
      return {
        acceptance: publicAcceptance(previous, device),
        replayed: true,
        ...proof,
      };
    }
    if (input.accepted && ["clear_buf", "reset_nvs"].includes(input.command))
      throw httpError(
        409,
        "Destructive commands require a separately reviewed buffer/counter reconciliation protocol; acceptance cannot enable them",
      );
    if (
      input.accepted &&
      (device.device_type !== "esp32" ||
        !["3.1", "v3.1"].includes(device.firmware_version) ||
        !/^[A-Za-z0-9_.:-]{1,120}$/.test(device.mqtt_topic_key || ""))
    )
      throw httpError(
        409,
        "Verify and register the ESP32 v3.1 device/topic binding before acceptance",
      );
    if (
      input.confirmation !== `ACCEPT ${input.command} ${device.device_uid}` &&
      input.accepted
    )
      throw httpError(
        400,
        "Acceptance confirmation must identify command and device UID",
      );
    const event = {
      ...clean,
      coop_id: coopId,
      actor_id: user.id,
      payload_hash: payloadHash,
      target_fingerprint: fingerprint(device),
      recorded_at: new Date(),
    };
    await model.insertAcceptance(event, connection);
    return {
      acceptance: publicAcceptance(event, device),
      replayed: false,
      ...proof,
    };
  });
}

function publish(topic, payload) {
  const client = publisher;
  if (
    !client?.connected ||
    client.disconnecting ||
    client.reconnecting ||
    client.options?.queueQoSZero !== false
  )
    throw Object.assign(new Error("broker_not_connected"), {
      maintenanceReason: "broker_not_connected",
    });
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve();
    };
    const timer = setTimeout(
      () =>
        finish(
          Object.assign(new Error("transport_callback_timeout"), {
            maintenanceReason: "transport_callback_timeout",
          }),
        ),
      5000,
    );
    try {
      client.publish(topic, payload, { qos: 0, retain: false }, finish);
    } catch (error) {
      finish(error);
    }
  });
}
async function submit(user, coopId, input) {
  await access.requireCoop(user, coopId, "owner");
  requireStorage(await storageAvailable());
  const payloadHash = hash([coopId, input]);
  const reservation = await withTransaction(async (connection) => {
    await access.lockCoop(connection, coopId);
    const actor = await currentActor(user, connection);
    const coop = await access.requireCoop(actor, coopId, "owner", connection);
    const device = await devices.lockById(input.device_id, connection);
    if (!device || Number(device.coop_id) !== Number(coopId))
      throw httpError(404, "Device not found in this coop");
    const previous = await model.byUuid(user.id, input.request_id, connection);
    if (previous) {
      if (previous.payload_hash !== payloadHash)
        throw httpError(
          409,
          "request_id already used for different maintenance payload",
        );
      await model.expireDevice(device.id, new Date(), connection);
      return {
        request: await model.byId(previous.id, connection),
        replayed: true,
      };
    }
    if (await model.legacyUuid(user.id, input.request_id, connection))
      throw httpError(
        409,
        "request_id belongs to legacy blocked audit; use a new explicit request, never replay it",
      );
    const now = new Date();
    await model.expireDevice(device.id, now, connection);
    const preflight = await capability(
      actor,
      coop,
      device,
      input.command,
      input.source,
      connection,
      true,
      { now },
    );
    const id = await model.insertRequest(
      {
        ...input,
        reason: safeText(input.reason, 500),
        coop_id: coopId,
        requested_by: user.id,
        payload_hash: payloadHash,
        target_fingerprint: fingerprint(device),
        status: preflight.allowed ? "accepted" : "blocked",
        http_status: preflight.allowed ? 202 : preflight.http_status,
        preflight,
        accepted_at: now,
        timeout_at: preflight.allowed
          ? new Date(now.getTime() + timeoutMs)
          : null,
        failure_reason: preflight.allowed ? null : preflight.reason,
      },
      connection,
    );
    return { request: await model.byId(id, connection), replayed: false };
  });
  // A UUID already present is read-only, even if a prior process died before/during publication.
  if (!reservation.replayed && reservation.request.status === "accepted") {
    try {
      await withTransaction(async (connection) => {
        await access.lockCoop(connection, coopId);
        const actor = await currentActor(user, connection);
        const coop = await access.requireCoop(
          actor,
          coopId,
          "owner",
          connection,
        );
        const device = await devices.lockById(input.device_id, connection);
        const row = await model.byId(reservation.request.id, connection);
        if (!row || row.status !== "accepted") return;
        const now = new Date();
        if (
          !device ||
          Number(device.coop_id) !== Number(coopId) ||
          fingerprint(device) !== row.target_fingerprint ||
          now >= new Date(row.timeout_at)
        ) {
          await model.finish(
            row.id,
            "blocked",
            409,
            "target_binding_changed_or_reservation_expired",
            now,
            connection,
          );
          return;
        }
        const preflight = await capability(
          actor,
          coop,
          device,
          input.command,
          input.source,
          connection,
          true,
          { ignoreRequestId: row.id, now },
        );
        if (!preflight.allowed) {
          await model.finish(
            row.id,
            "blocked",
            preflight.http_status,
            preflight.reason,
            now,
            connection,
          );
          return;
        }
        // Hold the same farm/coop/device locks as acceptance and relay writers through dispatch.
        // The earlier accepted audit is already committed; transaction/HTTP failure never triggers retry.
        await model.publishAttempt(row.id, now, connection);
        try {
          await publish(
            `coasther/device/${device.mqtt_topic_key}/control`,
            `${input.command}:${process.env.MQTT_CMD_TOKEN}`,
          );
          await model.finish(
            row.id,
            "published",
            202,
            null,
            new Date(),
            connection,
          );
        } catch (error) {
          const reason =
            error.maintenanceReason || "mqtt_publish_failed_outcome_unknown";
          await model.finish(
            row.id,
            reason === "transport_callback_timeout" ? "timed_out" : "failed",
            503,
            reason,
            new Date(),
            connection,
          );
        }
      });
    } catch (error) {
      // A post-reservation authorization/storage failure cannot authorize another publish.
      // If persistence is unavailable, accepted remains pending until timeout; physical outcome is unknown.
      try {
        await withTransaction(async (connection) => {
          await access.lockCoop(connection, coopId);
          await devices.lockById(input.device_id, connection);
          await model.finish(
            reservation.request.id,
            "failed",
            503,
            error.statusCode === 403
              ? "authorization_revoked_before_dispatch"
              : "dispatch_or_audit_failure_outcome_unknown",
            new Date(),
            connection,
          );
        });
      } catch {
        /* Existing durable reservation remains; never publish again. */
      }
    }
  }
  const row = await model.byId(reservation.request.id);
  const result = {
    request: present(row),
    capability: json(row.preflight_json),
    replayed: reservation.replayed,
    ...proof,
  };
  await emit(row);
  return { http_status: row.http_status, data: result };
}
async function busyForDevice(deviceId, connection = db) {
  if (!(await storageAvailable(connection))) return false;
  return Boolean(await model.pending(deviceId, connection));
}
async function emit(row) {
  if (!sockets) return;
  try {
    await require("./broilerSocket.service").publish(
      sockets,
      "maintenance_request_update",
      present(row),
    );
  } catch {
    /* REST remains authoritative; no retransmission. */
  }
}
async function observeControlStatus(
  topicKey,
  payload,
  { source, retained, receivedAt = new Date() } = {},
) {
  if (source !== "mqtt" || retained || !(await storageAvailable())) return;
  const device = await devices.findByTopicKey(topicKey);
  if (!device) return;
  const age = receivedAt.getTime() - new Date(payload.recorded_at).getTime();
  if (!Number.isFinite(age) || age < 0 || age > staleSeconds() * 1000) return;
  let observed;
  await withTransaction(async (connection) => {
    const coop = await access.lockCoop(connection, device.coop_id);
    const current = await devices.lockById(device.id, connection);
    if (
      !current?.is_active ||
      coop.status !== "active" ||
      current.mqtt_topic_key !== topicKey
    )
      return;
    await model.expireDevice(device.id, receivedAt, connection);
    const row = await model.pending(device.id, connection);
    if (
      !row ||
      !row.publish_attempted_at ||
      receivedAt < new Date(row.publish_attempted_at) ||
      fingerprint(current) !== row.target_fingerprint
    )
      return;
    const results = {
      status: ["status_sent"],
      sync_ntp: ["ntp_sync_ok", "ntp_sync_failed"],
      reboot: ["reboot_executed"],
    };
    if (
      !(results[row.command] || []).includes(payload.result) &&
      ![
        "rejected_invalid_token",
        "rejected_invalid_format",
        "unknown_command",
      ].includes(payload.result)
    )
      return;
    await model.observe(
      row.id,
      {
        result: payload.result,
        recorded_at: payload.recorded_at,
        received_at: receivedAt,
        correlated: false,
        semantics: "Generic device report; not evidence this request executed",
      },
      connection,
    );
    observed = await model.byId(row.id, connection);
  });
  if (observed) await emit(observed);
}
async function checkTimeouts() {
  if (checkingTimeouts) return;
  checkingTimeouts = true;
  try {
    if (!(await storageAvailable())) return;
    const now = new Date();
    for (const row of await model.expired(now)) {
      await withTransaction(async (connection) => {
        await access.lockCoop(connection, row.coop_id);
        await devices.lockById(row.device_id, connection);
        await model.expireDevice(row.device_id, now, connection);
      });
      await emit(await model.byId(row.id));
    }
  } catch {
    /* Read paths also reconcile deadlines. Never resend. */
  } finally {
    checkingTimeouts = false;
  }
}

module.exports = {
  configure,
  status,
  requestStatus,
  acceptance,
  submit,
  busyForDevice,
  observeControlStatus,
  checkTimeouts,
};
