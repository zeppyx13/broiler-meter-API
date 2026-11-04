const { staleSeconds } = require("./deviceStatus");

// Diagnostic receipt context only. Never use this as measurement time or a trusted heartbeat.
const invalidTimes = new Map();
function recordInvalidTimestamp(topicKey, receivedAt = new Date()) {
  if (
    typeof topicKey !== "string" ||
    !/^[A-Za-z0-9_.:-]{1,120}$/.test(topicKey)
  )
    return;
  const at = receivedAt.getTime();
  if (!Number.isFinite(at)) return;
  if (!invalidTimes.has(topicKey) && invalidTimes.size >= 256)
    invalidTimes.delete(invalidTimes.keys().next().value);
  invalidTimes.set(topicKey, Math.max(invalidTimes.get(topicKey) || 0, at));
}
function recentInvalidTimestamp(topicKey, now = new Date()) {
  const at = invalidTimes.get(topicKey);
  if (at === undefined) return null;
  if (now.getTime() - at > staleSeconds() * 1000) {
    invalidTimes.delete(topicKey);
    return null;
  }
  return at <= now.getTime() ? new Date(at) : null;
}
function clear(topicKey) {
  invalidTimes.delete(topicKey);
}

module.exports = { recordInvalidTimestamp, recentInvalidTimestamp, clear };
