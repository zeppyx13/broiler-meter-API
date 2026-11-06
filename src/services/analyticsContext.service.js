const crypto = require("node:crypto");
const model = require("../models/analyticsContext.model");
const accessModel = require("../models/access.model");
const dailyModel = require("../models/dailyMetrics.model");
const access = require("./access.service");
const daily = require("./dailyMetrics.service");
const { presentLive } = require("./dashboardMonitoring.service");
const { presentDevice } = require("../utils/deviceStatus");
const withTransaction = require("../utils/transaction");
const httpError = require("../utils/httpError");
const { localDate, dayAge } = require("../utils/farmDate");

const shiftDate = (date, amount) =>
  new Date(Date.parse(date) + amount * 86400000).toISOString().slice(0, 10);
const pick = (value, fields) =>
  Object.fromEntries(
    fields
      .filter((field) => value[field] !== undefined)
      .map((field) => [field, value[field]]),
  );

function alertEvidence(raw, depth = 0) {
  if (depth > 2) return {};
  let data;
  try {
    data = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return {};
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  const numeric = [
    "threshold",
    "recovery_threshold",
    "latest_value",
    "window_seconds",
    "recovery_window_sec",
    "samples",
    "stale_after_seconds",
    "observed_age_seconds",
  ];
  const dates = [
    "measurement_at",
    "window_started_at",
    "checked_at",
    "last_seen_at",
    "last_invalid_timestamp_at",
  ];
  const result = {};
  for (const field of numeric)
    if (typeof data[field] === "number" && Number.isFinite(data[field]))
      result[field] = data[field];
  for (const field of dates)
    if (
      typeof data[field] === "string" &&
      Number.isFinite(Date.parse(data[field]))
    )
      result[field] = new Date(data[field]).toISOString();
  if (["power_w", "flow_rate_lpm"].includes(data.metric))
    result.metric = data.metric;
  if (
    [
      "sustained_configured_threshold",
      "sustained_monitoring_unavailable",
      "invalid_timestamp_received",
      "sustained_recovery_threshold",
      "fresh_receipt_recovery_window",
    ].includes(data.reason)
  )
    result.reason = data.reason;
  if (
    ["trigger", "recovery", "normal", "insufficient_data"].includes(
      data.evaluation,
    )
  )
    result.evaluation = data.evaluation;
  if (data.latest_evaluation)
    result.latest_evaluation = alertEvidence(data.latest_evaluation, depth + 1);
  return result; // Operator notes, user IDs, arbitrary strings and raw sensor payloads are not analytics context.
}

function fingerprint(context) {
  const { generated_at, fingerprint: ignored, ...input } = context;
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex");
}

async function withContext(
  user,
  query = {},
  work = async (context) => context,
) {
  const source = query.source || "real";
  if (!["real", "simulation"].includes(source))
    throw httpError(400, "Invalid analytics source");
  const now = query.now || new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()))
    throw httpError(400, "Invalid analytics time");
  // Pick the existing accessible default without writing a profile as a side effect of advisory reads.
  const selected = query.coop_id
    ? { id: query.coop_id }
    : (await accessModel.findDefaultCoop(user)) ||
      (await accessModel.firstAccessibleCoop(user));
  if (!selected)
    return work(
      {
        state: "no_coop",
        source,
        is_simulated: source === "simulation",
        coop: null,
        farm: null,
        cycle: null,
        local_date: null,
        day_age: null,
        days: [],
        alerts: [],
        devices: [],
        live: null,
        generated_at: now.toISOString(),
        fingerprint: "no_coop",
      },
      null,
    );
  const location = await model.coopLocation(selected.id);
  if (!location) throw httpError(404, "Coop not found");
  return withTransaction(async (connection) => {
    // Immutable routing is read before the transaction; no joined read or RR snapshot precedes parent locks.
    await accessModel.lockFarm(location.farm_id, connection);
    await accessModel.lockCoop(selected.id, connection);
    const authorized = await access.requireCoop(
      user,
      selected.id,
      "read",
      connection,
    );
    const farm = await model.farm(location.farm_id, connection);
    const coop = pick(authorized, ["id", "farm_id", "code", "name", "status"]);
    const cycle = await model.activeCycle(coop.id, connection);
    const today = localDate(farm.timezone, now);
    const context = {
      state:
        !farm.is_active || coop.status !== "active"
          ? "inactive_coop"
          : cycle
            ? "ready"
            : "no_active_cycle",
      coop,
      farm: {
        ...farm,
        is_active: Boolean(farm.is_active),
        electricity_rate_idr_per_kwh: Number(farm.electricity_rate_idr_per_kwh),
        water_rate_idr_per_m3: Number(farm.water_rate_idr_per_m3),
      },
      cycle,
      local_date: today,
      day_age: cycle ? dayAge(cycle.placement_date, today) : null,
      source,
      is_simulated: source === "simulation",
      days: [],
      live: presentLive(
        await model.live(coop.id, connection),
        source === "simulation" ? "simulation" : "sensor",
        now,
      ),
      devices: (await model.devices(coop.id, connection)).map((device) =>
        pick(presentDevice(device, now), [
          "id",
          "name",
          "is_active",
          "connectivity_status",
          "last_seen_at",
        ]),
      ),
      alerts: (await model.alerts(coop.id, source, connection, now)).map(
        (alert) => ({
          ...alert,
          evidence_json: alertEvidence(alert.evidence_json),
        }),
      ),
      generated_at: now.toISOString(),
    };
    if (cycle && cycle.placement_date <= today) {
      const start = [cycle.placement_date, shiftDate(today, -59)].sort().at(-1);
      const config = {
        ...cycle,
        timezone: farm.timezone,
        electricity_rate_idr_per_kwh: farm.electricity_rate_idr_per_kwh,
        water_rate_idr_per_m3: farm.water_rate_idr_per_m3,
      };
      for (const date of daily.datesBetween(start, today, 60)) {
        const boundary = daily.calendarBoundary(date, farm.timezone);
        const next = daily.calendarBoundary(shiftDate(date, 1), farm.timezone);
        // Firmware accepts a small future clock skew, but projections never learn from future readings.
        const end = new Date(Math.min(next.getTime(), now.getTime() + 1));
        const groups = await dailyModel.dayReadings(
          coop.id,
          cycle.id,
          boundary,
          end,
          connection,
        );
        const population =
          Number(cycle.initial_population) +
          (await dailyModel.populationChanges(cycle.id, date, connection));
        if (
          !Number.isSafeInteger(population) ||
          population < 0 ||
          population > 4294967295
        )
          throw httpError(
            409,
            "Historical population is invalid; review flock events",
          );
        context.days.push(
          daily.buildDaily(config, date, population, groups, source),
        );
      }
      context.history_window = {
        start_date: start,
        end_date: today,
        maximum_days: 60,
        truncated: start > cycle.placement_date,
      };
    }
    context.today =
      context.days.find((day) => day.metric_date === today) || null;
    const sum = (field) => {
      const available = context.days.filter((day) => day[field] != null);
      return available.length
        ? Number(
            available.reduce((total, day) => total + day[field], 0).toFixed(6),
          )
        : null;
    };
    context.cycle_totals = context.history_window?.truncated
      ? {
          status: "not_available",
          reason: "history_window_truncated",
          water_liters: null,
          energy_kwh: null,
          electricity_cost_idr: null,
          water_cost_idr: null,
        }
      : {
          status: context.days.some(
            (day) => day.water_liters != null || day.energy_kwh != null,
          )
            ? "partial"
            : "no_data",
          water_liters: sum("water_liters"),
          energy_kwh: sum("energy_kwh"),
          electricity_cost_idr: sum("electricity_cost_idr"),
          water_cost_idr: sum("water_cost_idr"),
          population_basis: cycle?.current_population ?? null,
          population_basis_method: "current_population",
          missing_days: context.days.filter(
            (day) => day.water_liters == null || day.energy_kwh == null,
          ).length,
        };
    context.fingerprint = fingerprint(context);
    return work(context, connection);
  });
}

const load = (user, query) => withContext(user, query);
module.exports = { withContext, load, alertEvidence, fingerprint, shiftDate };
