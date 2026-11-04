const jwt = require("jsonwebtoken");
const { z } = require("zod");
const userModel = require("../models/user.model");
const access = require("./access.service");

const attached = new WeakSet();
const subscriptionSchema = z
  .object({
    coop_id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
const commonFields = [
  "coop_id",
  "device_id",
  "recorded_at",
  "received_at",
  "source",
  "is_latest",
];
const eventFields = {
  alert_created: [
    "id",
    "coop_id",
    "device_id",
    "alert_rule_id",
    "flock_cycle_id",
    "alert_type",
    "severity",
    "status",
    "title",
    "message",
    "source",
    "detected_at",
    "acknowledged_by",
    "acknowledged_at",
    "resolved_at",
  ],
  alert_updated: [
    "id",
    "coop_id",
    "device_id",
    "alert_rule_id",
    "flock_cycle_id",
    "alert_type",
    "severity",
    "status",
    "title",
    "message",
    "source",
    "detected_at",
    "acknowledged_by",
    "acknowledged_at",
    "resolved_at",
  ],
  notification_created: [
    "id",
    "coop_id",
    "user_id",
    "alert_id",
    "channel",
    "title",
    "body",
    "delivery_status",
    "sent_at",
    "read_at",
    "created_at",
    "source",
  ],
  notification_updated: [
    "id",
    "coop_id",
    "user_id",
    "alert_id",
    "channel",
    "title",
    "body",
    "delivery_status",
    "sent_at",
    "read_at",
    "created_at",
    "source",
  ],
  notification_unread_count: ["coop_id", "user_id", "unread_count"],
  relay_state_update: [
    "id",
    "coop_id",
    "device_id",
    "relay_id",
    "channel",
    "desired_state",
    "reported_state",
    "last_reported_at",
    "observed_at",
    "source",
    "retained",
  ],
  relay_command_update: [
    "id",
    "coop_id",
    "device_id",
    "relay_id",
    "correlation_id",
    "command",
    "status",
    "source",
    "requested_by",
    "requested_at",
    "published_at",
    "acked_at",
    "failure_reason",
  ],
  meter_update: [
    ...commonFields,
    "meter_id",
    "meter_uid",
    "type",
    "unit",
    "reading_value",
    "delta_value",
    "reading_status",
    "counter_epoch",
    "flock_cycle_id",
  ],
  telemetry_update: commonFields,
  device_status: [
    "coop_id",
    "device_id",
    "connectivity_status",
    "last_seen_at",
    "observed_at",
    "source",
    "is_latest",
  ],
};
const measurementFields = [
  "flow_rate_lpm",
  "water_total_liter",
  "voltage_v",
  "current_a",
  "power_w",
  "energy_kwh_total",
  "frequency_hz",
  "power_factor",
];
const snapshotFields = [
  ...measurementFields,
  "recorded_at",
  "source",
  "status",
];

function pick(value, fields) {
  return Object.fromEntries(
    fields
      .filter((field) => value[field] !== undefined)
      .map((field) => [field, value[field]]),
  );
}

function roomName(coopId) {
  return `coop:${coopId}`;
}

function clearWatermarks(socket, coopId) {
  for (const key of socket.data.broilerLatest?.keys() || []) {
    if (key.startsWith(`${coopId}:`)) socket.data.broilerLatest.delete(key);
  }
}

function orderedEnvelope(socket, event, envelope) {
  if (envelope.is_latest !== true) return envelope;
  const at = Date.parse(envelope.recorded_at || envelope.observed_at);
  if (!Number.isFinite(at)) return envelope;
  socket.data.broilerLatest ||= new Map();
  const identity =
    event === "meter_update"
      ? envelope.meter_id
      : event === "device_status"
        ? envelope.device_id
        : "snapshot";
  const stream = envelope.source === "simulation" ? "simulation" : "real";
  const key = `${envelope.coop_id}:${event}:${identity}:${stream}`;
  const previous = socket.data.broilerLatest.get(key);
  if (previous !== undefined && at < previous)
    return { ...envelope, is_latest: false };
  socket.data.broilerLatest.set(key, at);
  return envelope;
}

function tokenFor(socket) {
  const authToken = socket.handshake.auth?.token;
  if (typeof authToken === "string")
    return authToken.startsWith("Bearer ") ? authToken.slice(7) : authToken;
  const header = socket.handshake.headers?.authorization;
  return typeof header === "string" && header.startsWith("Bearer ")
    ? header.slice(7)
    : null;
}

async function currentUser(socket) {
  let payload;
  try {
    payload = jwt.verify(socket.data.broilerToken, process.env.JWT_SECRET, {
      algorithms: ["HS256"],
    });
    if (!Number.isSafeInteger(Number(payload.id)) || Number(payload.id) < 1)
      throw new Error("Invalid subject");
  } catch {
    throw Object.assign(new Error("Unauthorized"), { statusCode: 401 });
  }
  const user = await userModel.findById(payload.id);
  if (!user || !["admin", "manager", "operator"].includes(user.role)) {
    throw Object.assign(new Error("Unauthorized"), { statusCode: 401 });
  }
  return user;
}

function failure(error) {
  const statusCode =
    error instanceof z.ZodError ? 400 : error.statusCode || 500;
  return {
    success: false,
    message:
      statusCode === 400
        ? "Invalid subscription"
        : statusCode === 401
          ? "Unauthorized"
          : statusCode === 403
            ? "Forbidden"
            : statusCode === 404
              ? "Coop not found"
              : "Unable to process subscription",
    statusCode,
  };
}

function attach(io) {
  if (attached.has(io)) return;
  attached.add(io);
  io.use(async (socket, next) => {
    try {
      socket.data.broilerToken = tokenFor(socket);
      const user = await currentUser(socket);
      socket.data.broilerUserId = user.id;
      next();
    } catch {
      const error = new Error("Unauthorized");
      error.data = { statusCode: 401 };
      next(error);
    }
  });
  io.on("connection", (socket) => {
    socket.on("coop:subscribe", async (payload, acknowledge) => {
      const reply = typeof acknowledge === "function" ? acknowledge : () => {};
      try {
        const { coop_id } = subscriptionSchema.parse(payload);
        const user = await currentUser(socket);
        await access.requireCoop(user, coop_id);
        if (!socket.connected) return;
        await socket.join(roomName(coop_id));
        reply({ success: true, data: { coop_id, room: roomName(coop_id) } });
      } catch (error) {
        reply(failure(error));
        if (error.statusCode === 401) socket.disconnect(true);
      }
    });
    socket.on("coop:unsubscribe", async (payload, acknowledge) => {
      const reply = typeof acknowledge === "function" ? acknowledge : () => {};
      try {
        const { coop_id } = subscriptionSchema.parse(payload);
        await socket.leave(roomName(coop_id));
        clearWatermarks(socket, coop_id);
        reply({ success: true, data: { coop_id } });
      } catch (error) {
        reply(failure(error));
      }
    });
  });
}

async function publish(io, event, payload) {
  if (!eventFields[event]) throw new Error("Unsupported broiler socket event");
  const { coop_id } = subscriptionSchema.parse({ coop_id: payload.coop_id });
  const envelope = pick(payload, eventFields[event]);
  if (
    event === "telemetry_update" &&
    payload.snapshot &&
    typeof payload.snapshot === "object"
  ) {
    const source = payload.source === "simulation" ? "simulation" : "sensor";
    const projected = require("./dashboardMonitoring.service").presentLive(
      payload.snapshot,
      source,
    );
    envelope.snapshot = {
      ...pick(payload.snapshot, ["coop_id", "device_id"]),
      ...pick(projected, snapshotFields),
    };
    for (const field of [
      "field_status",
      "metric_recorded_at",
      "metric_device_id",
    ]) {
      envelope.snapshot[field] = pick(projected[field], measurementFields);
    }
  }
  const namespace = io.of("/");
  const room = roomName(coop_id);
  const personal = event.startsWith("notification_");
  if (
    personal &&
    (!Number.isSafeInteger(payload.user_id) || payload.user_id < 1)
  )
    throw new Error("Notification recipient is required");
  // Inbox events target the recipient's open browsers, including when a different coop is selected.
  const memberIds = personal
    ? [...namespace.sockets.values()]
        .filter(
          (socket) => Number(socket.data.broilerUserId) === payload.user_id,
        )
        .map((socket) => socket.id)
    : [...(namespace.adapter.rooms.get(room) || [])];
  let delivered = 0;
  await Promise.all(
    memberIds.map(async (id) => {
      const socket = namespace.sockets.get(id);
      if (!socket) return;
      try {
        // Membership and global role can change while a socket remains connected.
        const user = await currentUser(socket);
        if (personal && Number(user.id) !== payload.user_id) return;
        const coop = await access.requireCoop(user, coop_id);
        if (
          personal &&
          !["owner", "manager", "operator"].includes(coop.member_role)
        )
          return;
        if (socket.connected && (personal || socket.rooms.has(room))) {
          socket.emit(event, orderedEnvelope(socket, event, envelope));
          delivered++;
        }
      } catch (error) {
        if (error.statusCode === 401) socket.disconnect(true);
        else if (error.statusCode === 403 || error.statusCode === 404) {
          await socket.leave(room);
          clearWatermarks(socket, coop_id);
          socket.emit("coop:revoked", { coop_id });
        }
        // Failed authorization/database checks always suppress delivery.
      }
    }),
  );
  return { delivered };
}

module.exports = { attach, publish };
