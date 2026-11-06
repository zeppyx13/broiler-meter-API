const { localDate } = require("../utils/farmDate");
const { setTimeout: delay } = require("node:timers/promises");

const transientCodes = new Set([
  "ER_LOCK_DEADLOCK", "ER_LOCK_WAIT_TIMEOUT", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT",
  "PROTOCOL_CONNECTION_LOST", "PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR",
]);

function createRefresher({ recalculate = (reading) => require("./dailyMetrics.service").recalculateForReading(reading),
  diagnostics = require("../utils/mqttDiagnostics"), sleep = delay, backoffs = [100, 400] } = {}) {
  const pending = new Map();

  async function run(job, key) {
    let attempt = 0;
    let failed = false;
    try {
      while (true) {
        const version = job.version;
        attempt++;
        try {
          await recalculate(job.reading);
          if (failed) diagnostics.report({ ...job.context, stage: "metrics_retry", outcome: "metrics_recovered",
            reason_code: "METRICS_REFRESH_RECOVERED", attempt, retry_scheduled: false }, undefined, "info");
          // A reading committed while calculation held an older snapshot: refresh once more with latest input.
          if (version !== job.version) { attempt = 0; failed = false; continue; }
          return { status: "refreshed", attempts: attempt };
        } catch (error) {
          failed = true;
          const retry = transientCodes.has(error.code) && attempt <= backoffs.length;
          diagnostics.report({ ...job.context, stage: attempt === 1 ? "metrics_refresh" : "metrics_retry",
            outcome: retry ? "metrics_deferred" : "metrics_retry_exhausted",
            reason_code: retry ? "METRICS_REFRESH_FAILED" : "METRICS_RETRY_EXHAUSTED",
            attempt, retry_scheduled: retry, ...(retry ? { retry_in_ms: backoffs[attempt - 1] } : {}) }, error, retry ? "warn" : "error");
          if (!retry) return { status: "failed", attempts: attempt };
          await sleep(backoffs[attempt - 1]);
        }
      }
    } finally {
      // Clear synchronously before settling, so a newly committed reading cannot join a finished job.
      if (pending.get(key) === job) pending.delete(key);
    }
  }

  function refresh(reading, context = {}) {
    if (!reading?.flock_cycle_id) return Promise.resolve({ status: "skipped", attempts: 0 });
    // Production ingestion supplies the locked farm timezone. Legacy callers keep distinct instants.
    const day = reading.timezone ? localDate(reading.timezone, new Date(reading.recorded_at))
      : new Date(reading.recorded_at).toISOString();
    const key = `${reading.coop_id}:${reading.flock_cycle_id}:${day}`;
    const current = pending.get(key);
    if (current) {
      current.reading = reading;
      current.context = context;
      current.version++;
      return current.promise;
    }
    const job = { reading, context, version: 0 };
    pending.set(key, job);
    job.promise = run(job, key);
    return job.promise;
  }

  return { refresh };
}

let singleton;
function refresh(reading, context) {
  singleton ||= createRefresher();
  return singleton.refresh(reading, context);
}

module.exports = { createRefresher, refresh };
