const model = require("../models/guard.model");
const access = require("./access.service");
const accessModel = require("../models/access.model");
const withTransaction = require("../utils/transaction");
const httpError = require("../utils/httpError");
const validator = require("../validators/guard.validator");
const { createEngine } = require("./guardEngine.service");
const diagnostics = require("../utils/mqttDiagnostics");

const engine = createEngine();
const evaluations = new Map();
const effects = new Set();
let watchdogRunning = false;

function json(value) {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value || null;
}
function presentRule(rule) {
  return {
    ...rule,
    is_active: Boolean(rule.is_active),
    parameters_json: json(rule.parameters_json),
  };
}
function presentAlert(alert) {
  return alert ? { ...alert, evidence_json: json(alert.evidence_json) } : null;
}
function config(rule) {
  return validator.validateRule({
    coop_id: rule.coop_id,
    rule_code: rule.rule_code,
    name: rule.name,
    severity: rule.severity,
    parameters_json: json(rule.parameters_json),
    evaluation_window_sec: rule.evaluation_window_sec,
    cooldown_sec: rule.cooldown_sec,
    is_active: Boolean(rule.is_active),
  });
}
function warn(operation, error) {
  diagnostics.report(
    {
      stage: operation === "watchdog" ? "guard_watchdog" : "guard_evaluation",
      outcome: "processing_error",
      reason_code: "PHASE3_SERVICE_FAILED",
    },
    error,
  );
}
async function withCoop(coopId, work) {
  const location = await model.coopLocation(coopId);
  if (!location) throw httpError(404, "Coop not found");
  return withTransaction(async (connection) => {
    // No consistent or joined locking read occurs before these canonical parent locks.
    await accessModel.lockFarm(location.farm_id, connection);
    if (!(await accessModel.lockCoop(coopId, connection)))
      throw httpError(404, "Coop not found");
    return work(connection);
  });
}
async function resolveCoop(user, coopId) {
  if (coopId) return access.requireCoop(user, coopId);
  return access.resolveDefaultCoop(user);
}
function assertExpectedFlow(rule, now = new Date()) {
  if (rule.rule_code !== "no_water_flow" || !rule.is_active) return;
  const expires = Date.parse(rule.parameters_json.expected_flow_until);
  if (expires <= now.getTime() || expires > now.getTime() + 86400000) {
    throw httpError(
      400,
      "Expected inlet-flow context must expire in the next 24 hours",
    );
  }
}
async function assertTarget(rule, connection) {
  const target = rule.parameters_json.device_id;
  if (
    target &&
    !(await model.devices(rule.coop_id, connection)).some(
      (device) => String(device.id) === String(target),
    )
  ) {
    throw httpError(404, "Rule device not found in this coop");
  }
}
async function listRules(user, query) {
  const coop = await resolveCoop(user, query.coop_id);
  if (!coop)
    return {
      state: "no_coop",
      rules: [],
      meta: { page: query.page, limit: query.limit, total: 0 },
    };
  const rows = await model.rules(coop.id);
  return {
    coop_id: coop.id,
    rules: rows
      .slice((query.page - 1) * query.limit, query.page * query.limit)
      .map((row) => ({
        ...presentRule(row),
        evaluation: evaluations.get(`${row.id}:rule`) || {
          status: "not_evaluated",
          checked_at: null,
          subjects: [],
        },
      })),
    meta: { page: query.page, limit: query.limit, total: rows.length },
  };
}
async function getRule(user, id) {
  const location = await model.ruleLocation(id);
  if (!location) throw httpError(404, "Guard rule not found");
  await access.requireCoop(user, location.coop_id);
  return { rule: presentRule(await model.rule(id)) };
}
async function createRule(user, input) {
  const data = config(input);
  assertExpectedFlow(data);
  return withCoop(data.coop_id, async (connection) => {
    await access.requireCoop(user, data.coop_id, "manage", connection);
    await assertTarget(data, connection);
    const id = await model.createRule(data, connection);
    engine.clearCoop(data.coop_id);
    return { rule: presentRule(await model.rule(id, connection)) };
  });
}
async function updateRule(user, id, changes) {
  const location = await model.ruleLocation(id);
  if (!location) throw httpError(404, "Guard rule not found");
  return withCoop(location.coop_id, async (connection) => {
    await access.requireCoop(user, location.coop_id, "manage", connection);
    const current = await model.rule(id, connection);
    const data = config({ ...current, ...changes });
    assertExpectedFlow(data);
    await assertTarget(data, connection);
    await model.updateRule(id, data, connection);
    engine.clearCoop(location.coop_id);
    evaluations.delete(`${id}:rule`);
    evaluations.delete(`${id}:simulation`);
    return { rule: presentRule(await model.rule(id, connection)) };
  });
}
async function listAlerts(user, query) {
  const coop = await resolveCoop(user, query.coop_id);
  if (!coop)
    return {
      state: "no_coop",
      alerts: [],
      meta: { page: query.page, limit: query.limit },
    };
  const rows = await model.alerts(coop.id, query);
  return {
    coop_id: coop.id,
    alerts: rows.map(presentAlert),
    meta: {
      page: query.page,
      limit: query.limit,
      has_more: rows.length === query.limit,
    },
  };
}
async function getAlert(user, id) {
  const location = await model.alertLocation(id);
  if (!location) throw httpError(404, "Alert not found");
  await access.requireCoop(user, location.coop_id);
  return { alert: presentAlert(await model.alert(id)) };
}
function dispatch(event, alert, notifications, io) {
  const effect = Promise.resolve()
    .then(async () => {
      const work = [];
      if (io)
        work.push(
          Promise.resolve().then(() =>
            require("./broilerSocket.service").publish(io, event, alert),
          ),
        );
      if (event === "alert_created")
        work.push(
          Promise.resolve().then(() =>
            require("./notificationBroiler.service").afterAlert(
              alert,
              notifications,
              io,
            ),
          ),
        );
      for (const result of await Promise.allSettled(work))
        if (result.status === "rejected") warn("post_commit", result.reason);
    })
    .catch((error) => warn("post_commit", error));
  effects.add(effect);
  void effect.finally(() => effects.delete(effect));
}
async function acknowledge(user, id, { io, now = new Date() } = {}) {
  const location = await model.alertLocation(id);
  if (!location) throw httpError(404, "Alert not found");
  const result = await withCoop(location.coop_id, async (connection) => {
    await access.requireCoop(user, location.coop_id, "operate", connection);
    const alert = await model.alert(id, connection);
    if (alert.status === "resolved")
      throw httpError(409, "Resolved alerts cannot be acknowledged");
    await model.acknowledge(id, user.id, now, connection);
    return { alert: presentAlert(await model.alert(id, connection)) };
  });
  dispatch("alert_updated", result.alert, [], io);
  return result;
}
async function resolve(user, id, note, { io, now = new Date() } = {}) {
  const location = await model.alertLocation(id);
  if (!location) throw httpError(404, "Alert not found");
  const result = await withCoop(location.coop_id, async (connection) => {
    await access.requireCoop(user, location.coop_id, "manage", connection);
    const alert = await model.alert(id, connection);
    if (alert.status !== "resolved")
      await model.resolve(
        id,
        {
          ...json(alert.evidence_json),
          resolution: {
            method: "operator",
            user_id: user.id,
            note,
            at: now.toISOString(),
          },
        },
        now,
        connection,
      );
    return { alert: presentAlert(await model.alert(id, connection)) };
  });
  dispatch("alert_updated", result.alert, [], io);
  return result;
}

const messages = {
  device_offline: [
    "Monitoring perangkat tidak tersedia",
    "Perangkat tidak mengirim receipt valid dalam jendela yang dikonfigurasi. Ini bukan konfirmasi padam listrik atau kerusakan kipas.",
  ],
  suspected_power_anomaly: [
    "Dugaan anomali beban panel",
    "Daya panel valid berada di bawah ambang selama jendela pengamatan. Gangguan kipas individual tidak dapat dipastikan dari pengukuran panel.",
  ],
  suspected_water_anomaly: [
    "Dugaan anomali aliran masuk tandon",
    "Aliran inlet tandon berada di atas ambang secara berkelanjutan. Kebocoran belum terkonfirmasi dan volume minum ayam tidak diukur langsung.",
  ],
  no_water_flow: [
    "Dugaan aliran inlet tidak tersedia",
    "Aliran inlet tidak memenuhi ekspektasi yang dikonfigurasi selama jendela pengamatan. Periksa konteks pengisian dan kondisi tandon.",
  ],
};

async function evaluateCoop(
  coopId,
  { io, now = new Date(), source = "rule" } = {},
) {
  if (
    !["rule", "simulation"].includes(source) ||
    !Number.isFinite(now.getTime())
  )
    throw httpError(400, "Invalid Guard evaluation context");
  const outcome = await withCoop(coopId, async (connection) => {
    const coop = await model.coopContext(coopId, connection);
    if (coop.status !== "active" || !coop.farm_is_active)
      return {
        coop_id: coopId,
        skipped: true,
        reason: "inactive_coop",
        changes: [],
        evaluations: [],
      };
    const rules = await model.rules(coopId, connection);
    const devices = (await model.devices(coopId, connection)).map((device) => ({
      ...device,
      last_invalid_timestamp_at:
        require("../utils/iotInputHealth").recentInvalidTimestamp(
          device.mqtt_topic_key,
          now,
        ),
    }));
    const snapshot = await model.snapshot(coopId, connection);
    const cycleId = await model.activeCycle(coopId, connection);
    const changes = [];
    const results = [];
    for (const row of rules) {
      let rule;
      try {
        rule = { ...config(row), id: row.id };
      } catch {
        results.push({
          rule_id: row.id,
          status: "not_evaluated",
          reason: "invalid_rule_configuration",
        });
        continue;
      }
      const subjects = engine.evaluateRule(rule, {
        coopId,
        devices,
        snapshot,
        now,
        source,
      });
      results.push(...subjects);
      for (const decision of subjects) {
        if (
          !decision.device_id ||
          !["trigger", "recovery"].includes(decision.status)
        )
          continue;
        const key = `guard:${coopId}:${rule.id}:${decision.device_id}:${source}`;
        const prior = await model.latestEpisode(key, connection);
        const unresolved = prior && prior.status !== "resolved";
        const evidence = {
          ...decision.evidence,
          evaluation: decision.status,
          reason: decision.reason,
          source,
          checked_at: now.toISOString(),
          rule_code: rule.rule_code,
          severity_basis:
            "Configured deterministic threshold and sustained observation window",
        };
        if (decision.status === "trigger") {
          if (unresolved) {
            await model.updateEvidence(
              prior.id,
              { ...json(prior.evidence_json), latest_evaluation: evidence },
              connection,
            );
          } else if (
            !prior ||
            now.getTime() -
              new Date(prior.resolved_at || prior.detected_at).getTime() >=
              rule.cooldown_sec * 1000
          ) {
            const [title, message] = messages[rule.rule_code];
            const id = await model.createAlert(
              {
                coop_id: coopId,
                flock_cycle_id: cycleId,
                device_id: decision.device_id,
                alert_rule_id: rule.id,
                alert_type: rule.rule_code,
                severity: rule.severity,
                title,
                message,
                evidence_json: evidence,
                dedupe_key: key,
                source,
                detected_at: now,
              },
              connection,
            );
            const alert = presentAlert(await model.alert(id, connection));
            const notifications =
              await require("./notificationBroiler.service").createForAlert(
                connection,
                alert,
                coop,
              );
            changes.push({ event: "alert_created", alert, notifications });
          } else
            decision.cooldown_until = new Date(
              new Date(prior.resolved_at || prior.detected_at).getTime() +
                rule.cooldown_sec * 1000,
            ).toISOString();
        } else if (unresolved) {
          await model.resolve(
            prior.id,
            {
              ...json(prior.evidence_json),
              resolution: {
                method: "deterministic_recovery",
                at: now.toISOString(),
                evidence,
              },
            },
            now,
            connection,
          );
          changes.push({
            event: "alert_updated",
            alert: presentAlert(await model.alert(prior.id, connection)),
            notifications: [],
          });
        }
      }
    }
    return {
      coop_id: coopId,
      source,
      checked_at: now.toISOString(),
      evaluations: results,
      changes,
    };
  });
  for (const row of outcome.evaluations) {
    const key = `${row.rule_id}:${source}`;
    const subjects = outcome.evaluations.filter(
      (item) => item.rule_id === row.rule_id,
    );
    if (evaluations.size >= 1024 && !evaluations.has(key))
      evaluations.delete(evaluations.keys().next().value);
    evaluations.set(key, {
      status: subjects.some((item) => item.status === "trigger")
        ? "trigger"
        : subjects[0].status,
      checked_at: outcome.checked_at,
      source,
      subjects,
    });
  }
  for (const change of outcome.changes)
    dispatch(change.event, change.alert, change.notifications, io);
  return outcome;
}

async function status(user, query) {
  const coop = await resolveCoop(user, query.coop_id);
  if (!coop) return { state: "no_coop", evaluations: [] };
  return {
    coop_id: coop.id,
    source: query.source,
    evaluations: (await model.rules(coop.id)).map((rule) => ({
      rule_id: rule.id,
      rule_code: rule.rule_code,
      ...(evaluations.get(`${rule.id}:${query.source}`) || {
        status: "not_evaluated",
        checked_at: null,
        subjects: [],
      }),
    })),
  };
}
async function watchdog({ io, now = new Date(), source = "rule" } = {}) {
  if (!["rule", "simulation"].includes(source))
    throw httpError(400, "Invalid Guard evaluation source");
  if (watchdogRunning) return { skipped: true, reason: "watchdog_running" };
  watchdogRunning = true;
  let evaluated = 0;
  let failed = 0;
  try {
    let after = 0;
    for (;;) {
      const coops = await model.watchdogCoops(after);
      for (const coop of coops) {
        try {
          await evaluateCoop(coop.id, { io, now, source });
          evaluated++;
        } catch (error) {
          failed++;
          warn("watchdog", error);
        }
        after = coop.id;
      }
      if (coops.length < 100) break;
    }
    return { evaluated_coops: evaluated, failed_coops: failed };
  } finally {
    watchdogRunning = false;
  }
}

module.exports = {
  listRules,
  getRule,
  createRule,
  updateRule,
  listAlerts,
  getAlert,
  acknowledge,
  resolve,
  evaluateCoop,
  watchdog,
  status,
  flushEffects: () => Promise.all([...effects]),
};
