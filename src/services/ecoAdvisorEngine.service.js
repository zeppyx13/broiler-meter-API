const crypto = require("node:crypto");

const REQUIRED_DAYS = 4;
const INCREASE_THRESHOLD_PERCENT = 25;
const round = (value) => Number(value.toFixed(6));
const previousDate = (date) =>
  new Date(Date.parse(date) - 86400000).toISOString().slice(0, 10);
const definitions = {
  water:
    "Tank inlet water, not direct drinking intake per bird; tank buffering and filling schedules affect interpretation",
  electricity:
    "Aggregate panel energy, not consumption or failure of an individual blower/heater",
  quality:
    "Accepted deltas only. Calendar dates are closed, but sampling coverage remains partial and unproven",
  savings:
    "No validated intervention/counterfactual savings calculation; estimated_savings_idr is null",
};

function json(value) {
  try {
    return typeof value === "string" ? JSON.parse(value) : value || {};
  } catch {
    return {};
  }
}

function usableDays(context, metric) {
  const countField =
    metric === "water_liters"
      ? "water_accepted_intervals"
      : "electricity_accepted_intervals";
  const unique = new Map();
  for (const day of context.days || []) {
    if (
      day.source !== context.source ||
      String(day.flock_cycle_id) !== String(context.cycle.id) ||
      (day.coop_id != null &&
        String(day.coop_id) !== String(context.coop.id)) ||
      ["not_available", "no_data", "stale"].includes(
        day.metric_status?.[metric],
      ) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(day.metric_date) ||
      day.metric_date >= context.local_date ||
      day.metric_date < context.cycle.placement_date ||
      !(Number(day.evidence?.[countField]) > 0) ||
      day[metric] == null ||
      !Number.isFinite(Number(day[metric])) ||
      Number(day[metric]) < 0 ||
      !(Number(day.population_basis) > 0) ||
      !Number.isFinite(Number(day.population_basis))
    )
      continue;
    if (
      (context.source === "simulation") !==
      (day.data_quality === "simulated")
    )
      continue;
    unique.set(day.metric_date, {
      date: day.metric_date,
      value: Number(day[metric]),
      population_basis: Number(day.population_basis),
      per_bird: Number(day[metric]) / Number(day.population_basis),
      data_quality: day.data_quality,
    });
  }
  return [...unique.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function fingerprint(context, ruleCode, material) {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        coop_id: context.coop.id,
        flock_cycle_id: context.cycle.id,
        source: context.source,
        rule: ruleCode,
        material,
      }),
    )
    .digest("hex");
}

function recommendation(
  context,
  ruleCode,
  category,
  priority,
  title,
  description,
  evidence,
  material,
) {
  const hash = fingerprint(context, ruleCode, material);
  return {
    rule_code: ruleCode,
    category,
    priority,
    title,
    description,
    estimated_savings_idr: null,
    source: context.source === "simulation" ? "simulation" : "rule",
    fingerprint: hash,
    evidence_json: {
      advisor_version: 1,
      rule_code: ruleCode,
      fingerprint: hash,
      source: context.source,
      is_simulated: context.source === "simulation",
      definitions,
      ...evidence,
    },
  };
}

function evaluate(context) {
  const result = {
    state: context.state,
    source: context.source,
    is_simulated: context.source === "simulation",
    required_days: REQUIRED_DAYS,
    observed_days: { water: 0, electricity: 0 },
    recommendations: [],
    generated_at: context.generated_at,
    definitions,
  };
  if (context.state !== "ready" || !context.cycle) return result;
  const yesterday = previousDate(context.local_date);
  let needsCollection = false;
  const counts = {};
  for (const [metric, category] of [
    ["water_liters", "water"],
    ["energy_kwh", "electricity"],
  ]) {
    const days = usableDays(context, metric);
    result.observed_days[category] = days.length;
    const latest = days.at(-1);
    const previous = days.slice(0, -1).slice(-7);
    const baseline = previous.length
      ? previous.reduce((sum, day) => sum + day.per_bird, 0) / previous.length
      : null;
    counts[category] = {
      observed_days: days.length,
      latest_date: latest?.date || null,
      reason:
        days.length < REQUIRED_DAYS
          ? "insufficient_distinct_closed_days"
          : latest.date !== yesterday
            ? "recent_observation_missing"
            : !(baseline > 0)
              ? "nonpositive_comparison_baseline"
              : null,
    };
    if (counts[category].reason) {
      needsCollection = true;
      continue;
    }
    const change = (latest.per_bird / baseline - 1) * 100;
    if (change < INCREASE_THRESHOLD_PERCENT) continue;
    const label =
      category === "water" ? "tank-inlet water" : "aggregate panel energy";
    const window = {
      start_date: previous[0].date,
      end_date: latest.date,
      baseline_dates: previous.map((day) => day.date),
    };
    const material = {
      window,
      baseline_per_bird: round(baseline),
      latest_per_bird: round(latest.per_bird),
    };
    result.recommendations.push(
      recommendation(
        context,
        `${category}_intensity_increase`,
        category,
        "medium",
        `Review increased recorded ${label} per bird`,
        `The latest closed local date has higher recorded ${label} per bird than the preceding within-cycle observations. Inspect operating/filling schedules and meter coverage before changing practice. Bird growth, partial sampling and, for water, tank buffering may explain the difference; this is not proof of waste or equipment failure.`,
        {
          method: "latest_closed_day_vs_preceding_up_to_7_days_per_bird_mean",
          reason: "recorded_intensity_increase",
          window,
          observed_days: previous.length + 1,
          data_quality: [...new Set(days.map((day) => day.data_quality))],
          baseline_per_bird: round(baseline),
          latest_per_bird: round(latest.per_bird),
          latest_population_basis: latest.population_basis,
          latest_period_value: latest.value,
          change_percent: round(change),
          threshold_percent: INCREASE_THRESHOLD_PERCENT,
          unit: metric === "water_liters" ? "liter_per_bird" : "kwh_per_bird",
          sampling_coverage_verified: false,
        },
        material,
      ),
    );
  }
  if (needsCollection) {
    result.recommendations.push(
      recommendation(
        context,
        "collect_comparable_observations",
        "operations",
        "low",
        "Collect and check comparable daily monitoring evidence",
        "Check meter pairing, units, continuity and fresh receipts. Collect at least four distinct closed local dates with accepted intervals per metric: at least three baseline dates and one recent comparison date. Missing observations are not zero consumption; record population changes and tank-filling context before diagnosing efficiency or estimating savings.",
        {
          method: "accepted_interval_coverage_check",
          reason: "insufficient_comparable_history",
          required_days: REQUIRED_DAYS,
          observed_days: result.observed_days,
          metrics: counts,
          data_quality: "insufficient_data",
          window: {
            start_date: context.cycle.placement_date,
            end_date: yesterday,
          },
        },
        {
          local_date: context.local_date,
          metrics: Object.keys(counts).filter((key) => counts[key].reason),
        },
      ),
    );
  }
  for (const alert of context.alerts || []) {
    if (
      !["active", "acknowledged"].includes(alert.status) ||
      alert.source !== (context.source === "simulation" ? "simulation" : "rule")
    )
      continue;
    const evidence = json(alert.evidence_json);
    const latest = evidence.latest_evaluation || evidence;
    const supported =
      alert.alert_type === "device_offline"
        ? latest.reason === "sustained_monitoring_unavailable"
        : [
            "suspected_power_anomaly",
            "suspected_water_anomaly",
            "no_water_flow",
          ].includes(alert.alert_type) &&
          (latest.reason === "sustained_configured_threshold" ||
            (Number(latest.samples) >= 2 &&
              Number(latest.window_seconds) >= 10));
    if (!supported) continue;
    const category =
      alert.alert_type === "device_offline"
        ? "operations"
        : alert.alert_type === "suspected_power_anomaly"
          ? "electricity"
          : "water";
    result.recommendations.push(
      recommendation(
        context,
        `inspect_guard_${alert.alert_type}`,
        category,
        alert.severity === "critical" ? "high" : "medium",
        "Inspect an unresolved sustained Guard indication",
        category === "operations"
          ? "Review the referenced Guard episode and check device/network availability. Restore valid monitoring before evaluating efficiency; communication loss does not confirm a power outage."
          : category === "water"
            ? "Review the referenced sustained inlet-flow Guard episode and inspect tank filling, valves and pipes using fresh measurements. Leakage and actual drinking intake remain unconfirmed; the stored episode does not by itself establish the current condition."
            : "Review the referenced sustained panel-load Guard episode and inspect aggregate operating schedules and instrumentation using fresh measurements. A specific blower failure is not established; the stored episode does not by itself establish the current condition.",
        {
          method: "existing_sustained_guard_episode_reference",
          reason: "unresolved_guard_indication",
          alert_id: alert.id,
          alert_type: alert.alert_type,
          alert_status: alert.status,
          alert_detected_at: alert.detected_at,
          data_quality: "guard_evidence_requires_operator_inspection",
          evidence_window: {
            window_seconds: latest.window_seconds ?? null,
            window_started_at: latest.window_started_at ?? null,
            checked_at: latest.checked_at ?? null,
            samples: latest.samples ?? null,
          },
        },
        { alert_id: alert.id },
      ),
    );
  }
  result.state = needsCollection ? "insufficient_data" : "ready";
  return result;
}

module.exports = {
  evaluate,
  usableDays,
  REQUIRED_DAYS,
  INCREASE_THRESHOLD_PERCENT,
};
