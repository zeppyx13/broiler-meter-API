const crypto = require("node:crypto");
const { z } = require("zod");
const model = require("../models/notificationEmailBroiler.model");
const notifications = require("./notificationBroiler.service");
const access = require("./access.service");
const withTransaction = require("../utils/transaction");
const mailer = require("./notificationMailBroiler.service");
const logger = require("../config/logger");

const MAX_ATTEMPTS = 3;
const RETRY_SECONDS = [30, 120];
const CLAIM_SECONDS = 120;
const SEND_TIMEOUT_MS = 45000;
let running = false;
let lastWarning = 0;

function warn() {
  if (Date.now() - lastWarning < 30000) return;
  lastWarning = Date.now();
  logger.warn(
    "Broiler email worker operation deferred; inspect notification delivery audit",
  );
}

function deliveryFailure(error) {
  const response = Number(error?.responseCode);
  if (response >= 400 && response < 500)
    return {
      retryable: true,
      ambiguous: false,
      reason: "smtp_temporarily_rejected",
    };
  if (response >= 500 && response < 600)
    return { retryable: false, ambiguous: false, reason: "smtp_rejected" };
  if (error?.code === "EAUTH")
    return { retryable: false, ambiguous: false, reason: "smtp_auth_failed" };
  if (
    ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"].includes(error?.code) ||
    (error?.command === "CONN" &&
      ["ETIMEDOUT", "ESOCKET", "ECONNECTION"].includes(error?.code))
  ) {
    return {
      retryable: true,
      ambiguous: false,
      reason: "smtp_connection_failed",
    };
  }
  return { retryable: false, ambiguous: true, reason: "smtp_outcome_unknown" };
}

async function claim(candidate, now) {
  return withTransaction(async (connection) => {
    await access.lockCoop(connection, candidate.coop_id);
    const row = await model.lockContext(candidate.id, connection);
    if (!row || row.delivery_status !== "pending") return null;
    const audit = notifications.metadata(row.error_message);
    const attempts = Number.isInteger(audit.attempts)
      ? Math.max(0, audit.attempts)
      : 0;
    if (audit.state === "sending") {
      if (now.getTime() - Date.parse(audit.claimed_at) < CLAIM_SECONDS * 1000)
        return null;
      await model.setState(
        row.id,
        "failed",
        { state: "ambiguous", attempts, reason: "smtp_claim_expired" },
        null,
        connection,
      );
      return { finished: true, outcome: "ambiguous", row };
    }
    if (audit.next_at && Date.parse(audit.next_at) > now.getTime()) return null;
    const config = mailer.configuration();
    const reason =
      row.source === "simulation"
        ? "simulation_suppressed"
        : !["owner", "manager", "operator"].includes(row.recipient_role)
          ? "recipient_access_revoked"
          : !z.email().safeParse(row.email).success
            ? "recipient_invalid"
            : !config.enabled
              ? "email_disabled"
              : !config.configured
                ? "smtp_unconfigured"
                : attempts >= MAX_ATTEMPTS
                  ? "smtp_retry_exhausted"
                  : null;
    if (reason) {
      await model.setState(
        row.id,
        "failed",
        { state: "suppressed", attempts, reason },
        null,
        connection,
      );
      return { finished: true, outcome: "failed", row };
    }
    const next = {
      state: "sending",
      attempts: attempts + 1,
      claim: crypto.randomUUID(),
      claimed_at: now.toISOString(),
    };
    await model.setState(row.id, "pending", next, null, connection);
    return { row, audit: next, expected: JSON.stringify(next) };
  });
}

async function notify(io, row, audit, status, sentAt = null) {
  if (!io) return;
  try {
    await require("./broilerSocket.service").publish(
      io,
      "notification_updated",
      notifications.present({
        ...row,
        delivery_status: status,
        error_message: JSON.stringify(audit),
        sent_at: sentAt,
      }),
    );
  } catch {
    warn();
  }
}

async function deliver(item, clock, io, transport) {
  let timer;
  try {
    const info = await Promise.race([
      mailer.sendMail(mailer.message(item.row), { transport }),
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              Object.assign(new Error("SMTP outcome unknown"), {
                code: "SEND_DEADLINE",
              }),
            ),
          SEND_TIMEOUT_MS,
        );
      }),
    ]);
    const accepted =
      Array.isArray(info?.accepted) &&
      info.accepted.some(
        (address) =>
          String(
            typeof address === "object" ? address.address : address,
          ).toLowerCase() === item.row.email.toLowerCase(),
      );
    if (!accepted)
      throw Object.assign(new Error("SMTP did not confirm acceptance"), {
        responseCode: info?.rejected?.length ? 550 : undefined,
      });
    const sentAt = clock();
    const audit = { state: "smtp_accepted", attempts: item.audit.attempts };
    if (
      !(await model.finishClaim(
        item.row.id,
        item.expected,
        "sent",
        audit,
        sentAt,
      ))
    ) {
      warn();
      return "ambiguous";
    }
    await notify(io, item.row, audit, "sent", sentAt);
    return "sent";
  } catch (error) {
    const failure = deliveryFailure(error);
    const retry = failure.retryable && item.audit.attempts < MAX_ATTEMPTS;
    const audit = {
      state: retry ? "retry" : failure.ambiguous ? "ambiguous" : "failed",
      attempts: item.audit.attempts,
      reason: failure.reason,
      ...(retry
        ? {
            next_at: new Date(
              clock().getTime() + RETRY_SECONDS[item.audit.attempts - 1] * 1000,
            ).toISOString(),
          }
        : {}),
    };
    const status = retry ? "pending" : "failed";
    await model.finishClaim(item.row.id, item.expected, status, audit, null);
    await notify(io, item.row, audit, status);
    return retry ? "retry" : failure.ambiguous ? "ambiguous" : "failed";
  } finally {
    clearTimeout(timer);
  }
}

async function processPending({ limit = 10, now, io, transport } = {}) {
  if (running) return { busy: true };
  running = true;
  const result = { processed: 0, sent: 0, failed: 0, retry: 0, ambiguous: 0 };
  const clock = now ? () => new Date(now) : () => new Date();
  try {
    const maximum = Math.min(
      50,
      Math.max(1, Number.isInteger(limit) ? limit : 10),
    );
    for (const candidate of await model.candidates(
      Math.min(250, maximum * 5),
    )) {
      if (result.processed >= maximum) break;
      try {
        const item = await claim(candidate, clock());
        if (!item) continue;
        result.processed++;
        const outcome = item.finished
          ? item.outcome
          : await deliver(item, clock, io, transport);
        result[outcome]++;
      } catch {
        warn();
      }
    }
    return result;
  } finally {
    running = false;
  }
}

module.exports = {
  processPending,
  deliveryFailure,
  MAX_ATTEMPTS,
  RETRY_SECONDS,
  CLAIM_SECONDS,
};
