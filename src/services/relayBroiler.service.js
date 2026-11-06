const crypto = require("node:crypto");
const model = require("../models/relayBroiler.model");
const devices = require("../models/device.model");
const accessModel = require("../models/access.model");
const access = require("./access.service");
const withTransaction = require("../utils/transaction");
const httpError = require("../utils/httpError");
const { staleSeconds } = require("../utils/deviceStatus");
const validator = require("../validators/relayBroiler.validator");

let publisher = null;
let sockets = null;
const proof = {
  broker_receipt_confirmed: false,
  device_acknowledged: false,
  physical_state_confirmed: false,
};
const timeoutSeconds = () => {
  const value = Number(process.env.BROILER_RELAY_COMMAND_TIMEOUT_SECONDS || 30);
  return Number.isFinite(value) && value >= 5 && value <= 300 ? value : 30;
};

function configure({ client = null, io = null } = {}) {
  publisher = client;
  sockets = io;
}

async function emit(io, event, data) {
  if (!io) return;
  try {
    await require("./broilerSocket.service").publish(io, event, data);
  } catch (error) {
    require("../utils/mqttDiagnostics").report(
      {
        stage: "socket_emit",
        kind: "unknown",
        outcome: "processing_error",
        reason_code: "SOCKET_EMIT_FAILED",
        coop_id: data.coop_id,
        device_id: data.device_id,
        persisted: true,
      },
      error,
    );
  }
}

function present(relay, now = new Date()) {
  const age = relay.last_reported_at
    ? (now - new Date(relay.last_reported_at)) / 1000
    : NaN;
  return {
    ...relay,
    reported_status: !Number.isFinite(age)
      ? "unknown"
      : age < -300 || age > staleSeconds()
        ? "stale"
        : "observed",
    state_semantics:
      "Device-reported state only; no correlated command acknowledgement or physical load confirmation",
    ...proof,
  };
}

function ensureDevice(device) {
  if (
    device.device_type !== "esp32" ||
    !["3.1", "v3.1"].includes(device.firmware_version)
  ) {
    throw httpError(
      409,
      "Relay pairing requires an ESP32 explicitly registered with firmware v3.1",
    );
  }
}

async function routingFor(id) {
  const existing = await model.findById(id);
  if (!existing) throw httpError(404, "Relay not found");
  return existing;
}

async function lockRelay(id, connection, routing) {
  // Resolve immutable routing before the transaction, then lock parents without a pre-lock snapshot.
  await accessModel.lockFarm(routing.farm_id, connection);
  await accessModel.lockCoop(routing.coop_id, connection);
  const device = await devices.lockById(routing.device_id, connection);
  const relay = await model.lockById(id, connection);
  if (!relay || !device) throw httpError(404, "Relay not found");
  return { relay, device, coop_id: routing.coop_id };
}

async function list(user, query) {
  if (query.coop_id) await access.requireCoop(user, query.coop_id);
  if (query.device_id) {
    const device = await devices.findById(query.device_id);
    if (!device) throw httpError(404, "Device not found");
    await access.requireCoop(user, device.coop_id);
  }
  return {
    relays: (await model.list(user, query)).map((relay) => present(relay)),
    meta: query,
  };
}

async function detail(user, id) {
  const relay = await model.findById(id);
  if (!relay) throw httpError(404, "Relay not found");
  await access.requireCoop(user, relay.coop_id);
  return { relay: present(relay) };
}

async function create(user, payload) {
  return withTransaction(async (connection) => {
    const existing = await devices.findById(payload.device_id, connection);
    if (!existing) throw httpError(404, "Device not found");
    await access.lockCoop(connection, existing.coop_id);
    const coop = await access.requireCoop(
      user,
      existing.coop_id,
      "manage",
      connection,
    );
    const device = await devices.lockById(payload.device_id, connection);
    ensureDevice(device);
    if (!device.is_active || coop.status !== "active" || !coop.farm_is_active)
      throw httpError(409, "Device or coop is inactive");
    const id = await model.create(payload, connection);
    return {
      relay: present({
        ...(await model.lockById(id, connection)),
        coop_id: device.coop_id,
      }),
    };
  });
}

async function update(user, id, payload) {
  const routing = await routingFor(id);
  return withTransaction(async (connection) => {
    const { relay, device, coop_id } = await lockRelay(id, connection, routing);
    const coop = await access.requireCoop(user, coop_id, "manage", connection);
    if (
      payload.is_enabled === true &&
      (!device.is_active || coop.status !== "active" || !coop.farm_is_active)
    ) {
      throw httpError(409, "Device or coop is inactive");
    }
    await model.update(id, { ...relay, ...payload }, connection);
    return {
      relay: present({ ...(await model.lockById(id, connection)), coop_id }),
    };
  });
}

async function commands(user, id, query) {
  await detail(user, id);
  return {
    commands: (await model.commands(id, query)).map((command) => ({
      ...command,
      ...proof,
    })),
    meta: query,
  };
}

function publishCommand(topic, payload) {
  const client = publisher;
  if (!client?.connected)
    return Promise.reject(
      Object.assign(new Error("Broker is not connected"), {
        relayReason: "broker_not_connected",
      }),
    );
  if (client.options?.queueQoSZero !== false)
    return Promise.reject(
      Object.assign(new Error("Offline command queue must be disabled"), {
        relayReason: "offline_queue_not_disabled",
      }),
    );
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
          Object.assign(new Error("Publish callback timed out"), {
            relayReason: "publish_callback_timeout",
          }),
        ),
      5000,
    );
    try {
      client.publish(topic, payload, { qos: 0, retain: false }, (error) =>
        finish(error),
      );
    } catch (error) {
      finish(error);
    }
  });
}

async function sendCommand(user, id, payload) {
  const routing = await routingFor(id);
  const now = new Date();
  const reservation = await withTransaction(async (connection) => {
    const { relay, device, coop_id } = await lockRelay(id, connection, routing);
    const coop = await access.requireCoop(user, coop_id, "relay:operate", connection);
    ensureDevice(device);
    if (
      !relay.is_enabled ||
      relay.channel !== 1 ||
      !device.is_active ||
      coop.status !== "active" ||
      !coop.farm_is_active
    ) {
      throw httpError(409, "Relay, device or coop is inactive");
    }
    const seen = device.last_seen_at
      ? new Date(device.last_seen_at).getTime()
      : NaN;
    if (
      !Number.isFinite(seen) ||
      now.getTime() - seen > staleSeconds() * 1000 ||
      seen > now.getTime() + 300000
    ) {
      throw httpError(
        409,
        "Device has no fresh trusted heartbeat; command was not published",
      );
    }
    const previous = await model.latestCommand(id, connection);
    if (previous && ["queued", "published"].includes(previous.status)) {
      const cutoff = new Date(now.getTime() - timeoutSeconds() * 1000);
      if (!(await model.expire(previous.id, cutoff, connection)))
        throw httpError(409, "A command is already pending for this device");
    }
    if (
      previous &&
      now.getTime() - new Date(previous.requested_at).getTime() < 1000
    ) {
      throw httpError(409, "Wait before requesting another command");
    }
    const commandId = await model.insertCommand(
      {
        relay_id: id,
        requested_by: user.id,
        command: payload.command,
        correlation_id: crypto.randomUUID(),
        requested_at: now,
      },
      connection,
    );
    return {
      command: await model.commandById(commandId, connection),
      relay,
      device,
      coop_id,
    };
  });
  const targetIo = sockets;
  let status = "published";
  let failureReason = null;
  try {
    const token = process.env.MQTT_CMD_TOKEN;
    if (!token)
      throw Object.assign(new Error("Server command token is not configured"), {
        relayReason: "command_token_not_configured",
      });
    // A queued reservation can outlive access, device state or its timeout while waiting for locks.
    // Revalidate immediately before publication; never wait for Socket.io/database authorization broadcasts first.
    const target = await withTransaction(async (connection) => {
      const { relay, device, coop_id } = await lockRelay(
        id,
        connection,
        routing,
      );
      const coop = await access.requireCoop(
        user,
        coop_id,
        "relay:operate",
        connection,
      );
      const queued = await model.lockCommand(
        reservation.command.id,
        connection,
      );
      const instant = Date.now();
      if (!queued || queued.status !== "queued")
        throw Object.assign(new Error("Reservation is no longer queued"), {
          relayReason: "reservation_no_longer_queued",
        });
      if (
        instant - new Date(queued.requested_at).getTime() >=
        timeoutSeconds() * 1000
      ) {
        throw Object.assign(new Error("Reservation has expired"), {
          relayReason: "reservation_expired",
        });
      }
      ensureDevice(device);
      const seen = device.last_seen_at
        ? new Date(device.last_seen_at).getTime()
        : NaN;
      if (
        !relay.is_enabled ||
        relay.channel !== 1 ||
        !device.is_active ||
        coop.status !== "active" ||
        !coop.farm_is_active ||
        !Number.isFinite(seen) ||
        instant - seen > staleSeconds() * 1000 ||
        seen > instant + 300000
      ) {
        throw Object.assign(new Error("Target is no longer available"), {
          relayReason: "target_state_changed",
        });
      }
      return device;
    });
    await publishCommand(
      `coasther/device/${target.mqtt_topic_key}/control`,
      `relay_${payload.command}:${token}`,
    );
  } catch (error) {
    status = ["publish_callback_timeout", "reservation_expired"].includes(
      error.relayReason,
    )
      ? "timed_out"
      : "failed";
    failureReason =
      error.relayReason === "publish_callback_timeout"
        ? "Transport callback timeout is not cancellation; physical execution may still occur"
        : [
              "broker_not_connected",
              "offline_queue_not_disabled",
              "command_token_not_configured",
              "reservation_no_longer_queued",
              "reservation_expired",
              "target_state_changed",
            ].includes(error.relayReason)
          ? error.relayReason
          : error.statusCode === 403
            ? "authorization_revoked_before_publication"
            : "mqtt_publish_failed";
  }
  const command = await withTransaction(async (connection) => {
    await lockRelay(id, connection, routing);
    await model.transition(
      reservation.command.id,
      status,
      new Date(),
      failureReason,
      connection,
    );
    return model.commandById(reservation.command.id, connection);
  });
  await emit(targetIo, "relay_command_update", {
    ...command,
    relay_id: id,
    device_id: reservation.device.id,
    coop_id: reservation.coop_id,
  });
  return {
    command: { ...command, ...proof },
    ...proof,
    publication_semantics:
      "QoS0 transport callback only; no broker PUBACK or device correlation is available",
  };
}

async function observeState(
  mapping,
  state,
  date,
  { source, retained, receivedAt, io, observation },
) {
  if (!["mqtt", "sensor"].includes(source))
    return { outcome: "simulation_ignored" };
  const age = (receivedAt.getTime() - date.getTime()) / 1000;
  if (date.getUTCFullYear() < 2000 || age < -300 || age > staleSeconds())
    return { outcome: "stale_or_invalid_status" };
  const result = await withTransaction(async (connection) => {
    const coop = await access.lockCoop(connection, mapping.coop_id);
    const device = await devices.lockById(
      mapping.device_id || mapping.id,
      connection,
    );
    if (
      !device.is_active ||
      coop.status !== "active" ||
      !(await model.farmIsActive(coop.farm_id, connection))
    )
      return { outcome: "disabled" };
    const relay = await model.forDevice(device.id, connection);
    if (!relay) return { outcome: "unpaired" };
    if (
      (retained && relay.last_reported_at) ||
      (relay.last_reported_at && date <= new Date(relay.last_reported_at))
    )
      return { outcome: "stale_status" };
    await model.reportState(relay.id, state, date, connection);
    return {
      outcome: "observed",
      relay: {
        ...relay,
        coop_id: device.coop_id,
        reported_state: state,
        last_reported_at: date,
      },
    };
  });
  if (result.relay)
    await emit(io || sockets, "relay_state_update", {
      ...result.relay,
      relay_id: result.relay.id,
      observed_at: receivedAt,
      source: observation,
      retained,
    });
  return result;
}

async function observeControlStatus(
  topicKey,
  payload,
  { retained = false, source = "mqtt", receivedAt = new Date(), io } = {},
) {
  const parsed = validator.controlStatusSchema.safeParse(payload);
  if (!parsed.success) return { outcome: "invalid_status" };
  if (!["mqtt", "sensor"].includes(source))
    return { outcome: "simulation_ignored" };
  const device = await devices.findByTopicKey(topicKey);
  if (!device) return { outcome: "unmapped" };
  return observeState(
    device,
    parsed.data.relay_state,
    parsed.data.recorded_at,
    { retained, source, receivedAt, io, observation: "control_status" },
  );
}

async function observeTelemetry(
  deviceContext,
  payload,
  { retained = false, source = "mqtt", receivedAt = new Date(), io } = {},
) {
  const parsed = validator.telemetryStateSchema.safeParse(payload);
  if (!parsed.success) return { outcome: "no_relay_state" };
  return observeState(
    deviceContext,
    parsed.data.relay_cutoff ? "off" : "on",
    parsed.data.recorded_at,
    { retained, source, receivedAt, io, observation: "telemetry" },
  );
}

async function checkTimeouts(io = sockets, now = new Date()) {
  const cutoff = new Date(now.getTime() - timeoutSeconds() * 1000);
  let count = 0;
  for (const item of await model.pendingBefore(cutoff)) {
    const routing = await routingFor(item.relay_id);
    const command = await withTransaction(async (connection) => {
      await lockRelay(item.relay_id, connection, routing);
      return (await model.expire(item.id, cutoff, connection))
        ? model.commandById(item.id, connection)
        : null;
    });
    if (!command) continue;
    count++;
    await emit(io, "relay_command_update", {
      ...command,
      relay_id: item.relay_id,
      device_id: item.device_id,
      coop_id: item.coop_id,
    });
  }
  return count;
}

module.exports = {
  configure,
  list,
  detail,
  create,
  update,
  commands,
  sendCommand,
  observeControlStatus,
  observeTelemetry,
  checkTimeouts,
  present,
};
