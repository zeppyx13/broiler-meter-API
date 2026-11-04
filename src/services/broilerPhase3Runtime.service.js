const diagnostics = require("../utils/mqttDiagnostics");

// Each job runs after the ingestion transaction. A failed downstream service cannot roll it back.
function createRuntime({
  evaluate = (...args) => require("./guard.service").evaluateCoop(...args),
  observe = (...args) =>
    require("./relayBroiler.service").observeTelemetry(...args),
  watchdog = (...args) => require("./guard.service").watchdog(...args),
  timeouts = (...args) =>
    require("./relayBroiler.service").checkTimeouts(...args),
  emails = (...args) =>
    require("./notificationEmailBroiler.service").processPending(...args),
  statuses = (...args) =>
    require("./iotBroiler.service").checkDeviceStatus(...args),
  report = diagnostics.report,
} = {}) {
  let enabled = false;
  let io;
  const pending = new Map();
  const periodic = new Map();
  const safe = async (stage, work, context = {}) => {
    try {
      return await work();
    } catch (error) {
      report(
        {
          ...context,
          stage,
          outcome: "processing_error",
          reason_code: "PHASE3_SERVICE_FAILED",
        },
        error,
      );
      return null;
    }
  };

  function configure(options = {}) {
    io = options.io;
    enabled = options.enabled !== false;
  }

  function enqueue(result, payload, options = {}) {
    if (
      !enabled ||
      !result.coop_id ||
      !["stored", "duplicate", "historical_telemetry"].includes(result.outcome)
    )
      return null;
    const source = options.source === "simulation" ? "simulation" : "rule";
    const key = `${result.coop_id}:${result.device_id || 0}:${source}`;
    let job = pending.get(key);
    if (job) {
      if (
        payload?.relay_cutoff !== undefined &&
        (!job.observation ||
          new Date(payload.recorded_at).getTime() >
            new Date(job.observation.payload.recorded_at).getTime())
      ) {
        job.observation = { result, payload, options };
      }
      job.version++;
      return job.promise;
    }
    if (pending.size >= 256) {
      report({
        coop_id: result.coop_id,
        stage: "guard_evaluation",
        outcome: "processing_error",
        reason_code: "PHASE3_QUEUE_FULL",
      });
      return null; // Watchdog still evaluates every enabled coop; never retain unbounded sensor payloads.
    }
    job = {
      observation:
        payload?.relay_cutoff !== undefined
          ? { result, payload, options }
          : null,
      version: 1,
    };
    pending.set(key, job);
    job.promise = (async () => {
      // Defer execution beyond the ingest caller, including synchronous mocked dependencies.
      await new Promise((resolve) => setImmediate(resolve));
      try {
        while (enabled) {
          const version = job.version;
          const current = job.observation;
          job.observation = null;
          if (current) {
            await safe(
              "relay_observation",
              () =>
                observe(current.result, current.payload, {
                  ...current.options,
                  io: current.options.io || io,
                }),
              { coop_id: result.coop_id },
            );
          }
          await safe(
            "guard_evaluation",
            () => evaluate(result.coop_id, { io, source }),
            { coop_id: result.coop_id },
          );
          if (version === job.version) break;
        }
      } finally {
        // Remove before settling, so callers cannot reuse an already-finished promise.
        if (pending.get(key) === job) pending.delete(key);
      }
    })();
    return job.promise;
  }

  function tick() {
    if (!enabled) return Promise.resolve([]);
    const tasks = {
      device_timeout: () => statuses(io),
      guard_watchdog: () => watchdog({ io }),
      relay_timeout: () => timeouts(io),
      notification_email: () => emails({ limit: 10, io }),
    };
    for (const [stage, work] of Object.entries(tasks)) {
      if (periodic.has(stage)) continue;
      const job = safe(stage, work).finally(() => periodic.delete(stage));
      periodic.set(stage, job);
    }
    return Promise.allSettled([...periodic.values()]);
  }

  async function stop() {
    enabled = false;
    await Promise.allSettled(
      [...pending.values()]
        .map((job) => job.promise)
        .concat([...periodic.values()]),
    );
  }

  return { configure, enqueue, tick, stop };
}

module.exports = { createRuntime, ...createRuntime() };
