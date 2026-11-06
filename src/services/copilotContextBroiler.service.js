const crypto = require("node:crypto");
const analytics = require("./analyticsContext.service");
const forecast = require("./forecastEngine.service");
const eco = require("./ecoAdvisorEngine.service");
const { cleanText } = require("./geminiBroiler.service");

const metrics = [
  "flow_rate_lpm",
  "water_total_liter",
  "voltage_v",
  "current_a",
  "power_w",
  "energy_kwh_total",
  "frequency_hz",
  "power_factor",
];
const pick = (value, keys) =>
  Object.fromEntries(
    keys
      .filter((key) => value?.[key] !== undefined)
      .map((key) => [key, value[key]]),
  );
const finite = (value) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const mapMetrics = (data = {}) =>
  Object.fromEntries(
    metrics
      .filter((key) => data[key] !== undefined)
      .map((key) => [key, data[key]]),
  );

function daySummary(day) {
  if (!day) return null;
  return {
    ...pick(day, [
      "metric_date",
      "day_age",
      "population_basis",
      "source",
      "data_quality",
      "status",
      "last_reading_at",
    ]),
    water_liters: finite(day.water_liters),
    energy_kwh: finite(day.energy_kwh),
    electricity_cost_idr: finite(day.electricity_cost_idr),
    water_cost_idr: finite(day.water_cost_idr),
    metric_status: pick(day.metric_status, ["water_liters", "energy_kwh"]),
    accepted_intervals: pick(day.evidence, [
      "water_accepted_intervals",
      "electricity_accepted_intervals",
    ]),
  };
}

// Stable identity/cohort, not changing five-second telemetry: answers explicitly describe their initial as-of snapshot.
function cohort(context) {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        coop: pick(context.coop, ["id", "farm_id", "status"]),
        farm: pick(context.farm, [
          "id",
          "timezone",
          "is_active",
          "electricity_rate_idr_per_kwh",
          "water_rate_idr_per_m3",
        ]),
        cycle: pick(context.cycle, [
          "id",
          "placement_date",
          "planned_harvest_date",
          "current_population",
          "initial_population",
          "status",
        ]),
        source: context.source,
        local_date: context.local_date,
      }),
    )
    .digest("hex");
}

function summarize(context) {
  const projected = forecast.project(context);
  const recommendations = eco.evaluate(context);
  const days = (context.days || []).filter(
    (day) => day.source === context.source,
  );
  const sum = (metric) => {
    const valid = days.filter(
      (day) =>
        typeof day[metric] === "number" &&
        Number.isFinite(day[metric]) &&
        day.metric_status?.[metric] !== "not_available",
    );
    return valid.length
      ? Number(valid.reduce((total, day) => total + day[metric], 0).toFixed(6))
      : null;
  };
  const live = context.live || {};
  const result = {
    as_of: context.generated_at,
    source: context.source,
    is_simulated: context.source === "simulation",
    state: context.state,
    local_date: context.local_date,
    coop: {
      ...pick(context.coop, ["id", "code", "status"]),
      name: cleanText(context.coop?.name, 120),
    },
    farm: pick(context.farm, [
      "timezone",
      "electricity_rate_idr_per_kwh",
      "water_rate_idr_per_m3",
    ]),
    cycle: {
      ...pick(context.cycle, [
        "id",
        "placement_date",
        "planned_harvest_date",
        "current_population",
        "initial_population",
        "status",
      ]),
      day_age: context.day_age,
    },
    live: {
      ...pick(live, ["status", "source", "recorded_at"]),
      ...Object.fromEntries(metrics.map((key) => [key, finite(live[key])])),
      field_status: mapMetrics(live.field_status),
      metric_recorded_at: mapMetrics(live.metric_recorded_at),
    },
    today: daySummary(
      days.find((day) => day.metric_date === context.local_date),
    ),
    recent_history: days.slice(-7).map(daySummary),
    cycle_observation: {
      window_start: days[0]?.metric_date || null,
      window_end: days.at(-1)?.metric_date || null,
      observed_calendar_days: days.length,
      water_liters: sum("water_liters"),
      energy_kwh: sum("energy_kwh"),
      status: "accepted_intervals_only_partial_coverage",
      complete_cycle_coverage: false,
    },
    alerts: (context.alerts || []).slice(0, 8).map((alert) => ({
      ...pick(alert, [
        "id",
        "alert_type",
        "severity",
        "status",
        "source",
        "detected_at",
        "resolved_at",
      ]),
      title: cleanText(alert.title, 160),
      message: cleanText(alert.message, 300),
      evidence: pick(alert.evidence_json, [
        "metric",
        "threshold",
        "latest_value",
        "window_seconds",
        "samples",
        "measurement_at",
        "evaluation",
        "reason",
      ]),
    })),
    forecast: {
      ...pick(projected, [
        "state",
        "required_days",
        "observed_days",
        "eligible_days",
        "remaining_days",
        "method",
        "confidence",
      ]),
      horizons: projected.horizons,
      limitations: (projected.limitations || []).slice(0, 5),
      estimates: (projected.forecasts || [])
        .slice(0, 6)
        .map((row) =>
          pick(row, [
            "metric",
            "horizon",
            "target_date",
            "predicted_value",
            "method",
            "confidence",
            "input_days",
          ]),
        ),
    },
    eco_advisor: {
      state: recommendations.state,
      recommendations: (recommendations.recommendations || [])
        .slice(0, 4)
        .map((row) => ({
          ...pick(row, [
            "rule_code",
            "category",
            "priority",
            "source",
            "estimated_savings_idr",
          ]),
          title: cleanText(row.title, 160),
          description: cleanText(row.description, 400),
          evidence: pick(row.evidence_json, [
            "method",
            "reason",
            "data_quality",
            "window",
            "baseline_days",
            "threshold_percent",
            "increase_percent",
          ]),
        })),
    },
    limitations: [
      "Water is tank-inlet proxy, not exact drinking intake; electricity is total panel load.",
      "Null/stale/missing values are unavailable, not zero. Totals represent accepted intervals within the shown window only.",
      "This is a read-only advisory snapshot as of as_of, not a live action or confirmed diagnosis.",
    ],
  };
  if (context.cycle_totals)
    result.cycle_totals = pick(context.cycle_totals, [
      "water_liters",
      "energy_kwh",
      "electricity_cost_idr",
      "water_cost_idr",
      "status",
      "reason",
      "data_quality",
    ]);
  if (context.history_window)
    result.history_window = pick(context.history_window, [
      "start_date",
      "end_date",
      "maximum_days",
      "truncated",
    ]);
  // Bound context independently of arbitrary source text and dataset length.
  if (Buffer.byteLength(JSON.stringify(result)) > 12000) {
    result.recent_history = result.recent_history.slice(-3);
    result.alerts = result.alerts.slice(0, 4);
    result.eco_advisor.recommendations =
      result.eco_advisor.recommendations.slice(0, 2);
  }
  return result;
}

async function load(user, query) {
  const context = await analytics.load(user, query);
  return { context, summary: summarize(context), cohort: cohort(context) };
}

module.exports = { load, summarize, cohort };
