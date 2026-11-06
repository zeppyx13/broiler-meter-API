const { z } = require("zod");
const model = require("../models/notificationBroiler.model");
const access = require("./access.service");
const withTransaction = require("../utils/transaction");
const httpError = require("../utils/httpError");
const logger = require("../config/logger");
const recipientRoles = ["owner", "manager", "operator"];
const auditStates = new Set([
  "queued",
  "sending",
  "retry",
  "suppressed",
  "ambiguous",
  "smtp_accepted",
  "failed",
]);
const auditReasons = new Set([
  "simulation_suppressed",
  "recipient_invalid",
  "recipient_access_revoked",
  "email_disabled",
  "smtp_unconfigured",
  "smtp_retry_exhausted",
  "smtp_claim_expired",
  "smtp_temporarily_rejected",
  "smtp_rejected",
  "smtp_auth_failed",
  "smtp_connection_failed",
  "smtp_outcome_unknown",
]);
let lastSocketWarning = 0;

function metadata(value) {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function present(row) {
  const audit = metadata(row.error_message);
  return {
    id: row.id,
    user_id: row.user_id,
    alert_id: row.alert_id,
    coop_id: row.coop_id,
    channel: row.channel,
    title: row.title,
    body: row.body,
    source: row.source,
    delivery_status: row.delivery_status,
    sent_at: row.sent_at,
    read_at: row.read_at,
    created_at: row.created_at,
    attempt_count: Number.isInteger(audit.attempts) ? audit.attempts : 0,
    delivery_state: auditStates.has(audit.state)
      ? audit.state
      : row.delivery_status,
    error_message: auditReasons.has(audit.reason)
      ? audit.reason
      : audit.reason
        ? "delivery_failed"
        : null,
    next_retry_at:
      typeof audit.next_at === "string" &&
      Number.isFinite(Date.parse(audit.next_at))
        ? new Date(audit.next_at).toISOString()
        : null,
  };
}

// Guard calls only for a new episode created in this transaction, while holding farm -> coop.
// Repeated calls in that transaction see their own inserts. Avoid empty-range notification locks.
async function createForAlert(connection, alert, coop) {
  const stored = await model.lockAlert(alert.id, connection);
  if (!stored || String(stored.coop_id) !== String(coop.id))
    throw httpError(409, "Alert and coop do not match");
  const isSimulation = stored.source === "simulation";
  const title = `${isSimulation ? "[SIMULATION] " : ""}${stored.title}`.slice(
    0,
    160,
  );
  const body = `${isSimulation ? "SIMULATION: " : ""}${stored.message}`.slice(
    0,
    16000,
  );
  const created = [];
  for (const recipient of await model.recipients(coop.farm_id, connection, coop.id)) {
    const channels = [
      "in_app",
      ...(["warning", "critical"].includes(stored.severity) ? ["email"] : []),
    ];
    for (const channel of channels) {
      if (await model.existing(stored.id, recipient.id, channel, connection))
        continue;
      const reason = isSimulation
        ? "simulation_suppressed"
        : !z.email().safeParse(recipient.email).success
          ? "recipient_invalid"
          : null;
      const deliveryStatus =
        channel === "in_app" ? "sent" : reason ? "failed" : "pending";
      const id = await model.create(
        {
          user_id: recipient.id,
          alert_id: stored.id,
          channel,
          title,
          body,
          delivery_status: deliveryStatus,
          sent_at: channel === "in_app" ? new Date() : null,
          error_message:
            channel === "email"
              ? JSON.stringify({
                  state: reason ? "suppressed" : "queued",
                  attempts: 0,
                  ...(reason ? { reason } : {}),
                })
              : null,
        },
        connection,
      );
      created.push(await model.findById(id, connection));
    }
  }
  return created;
}

async function emit(io, event, row) {
  if (!io) return;
  try {
    await require("./broilerSocket.service").publish(io, event, present(row));
  } catch {
    if (Date.now() - lastSocketWarning >= 30000) {
      lastSocketWarning = Date.now();
      logger.warn(
        "Broiler notification socket delivery deferred; REST inbox remains available",
      );
    }
  }
}

async function afterAlert(alert, rows, io) {
  for (const row of rows.filter((item) => item.channel === "in_app"))
    await emit(io, "notification_created", row);
  // Email is durable pending work; the runtime worker sends outside the Guard/ingestion transaction.
  return {
    created: rows.length,
    email_pending: rows.filter(
      (item) => item.channel === "email" && item.delivery_status === "pending",
    ).length,
  };
}

async function list(user, query) {
  if (query.coop_id) await access.requireCoop(user, query.coop_id);
  const result = await model.list(user, query);
  return {
    notifications: result.rows.map(present),
    unread_count: await model.unreadCount(user, query.coop_id),
    meta: {
      page: query.page,
      limit: query.limit,
      total: result.total,
      has_more: query.page * query.limit < result.total,
      channel: query.channel,
    },
  };
}

async function unread(user, query) {
  if (query.coop_id) await access.requireCoop(user, query.coop_id);
  return { unread_count: await model.unreadCount(user, query.coop_id) };
}

async function read(user, id, io) {
  const existing = await model.findById(id);
  if (
    !existing ||
    String(existing.user_id) !== String(user.id) ||
    existing.channel !== "in_app"
  ) {
    throw httpError(404, "Notification not found");
  }
  const row = await withTransaction(async (connection) => {
    await access.lockCoop(connection, existing.coop_id);
    const coop = await access.requireCoop(
      user,
      existing.coop_id,
      "read",
      connection,
    );
    if (!recipientRoles.includes(coop.member_role))
      throw httpError(403, "Notification access revoked");
    await model.markRead(id, user.id, connection);
    return model.findById(id, connection);
  });
  await emit(io, "notification_updated", row);
  return {
    notification: present(row),
    unread_count: await model.unreadCount(user),
  };
}

async function readAll(user, query) {
  if (query.coop_id) await access.requireCoop(user, query.coop_id);
  let updated = 0;
  for (const row of await model.unreadCoops(user)) {
    if (query.coop_id && String(query.coop_id) !== String(row.coop_id))
      continue;
    try {
      updated += await withTransaction(async (connection) => {
        await access.lockCoop(connection, row.coop_id);
        const coop = await access.requireCoop(
          user,
          row.coop_id,
          "read",
          connection,
        );
        if (!recipientRoles.includes(coop.member_role))
          throw httpError(403, "Notification access revoked");
        return model.markCoopRead(row.coop_id, user.id, connection);
      });
    } catch (error) {
      if (![403, 404].includes(error.statusCode)) throw error;
    }
  }
  return {
    updated,
    unread_count: await model.unreadCount(user, query.coop_id),
  };
}

module.exports = {
  createForAlert,
  afterAlert,
  list,
  unread,
  read,
  readAll,
  present,
  metadata,
};
