const crypto = require("node:crypto");

const requiredDays = 3;
const round = (value, digits = 4) => Number(value.toFixed(digits));
const addDays = (date, days) =>
  new Date(Date.parse(date) + days * 86400000).toISOString().slice(0, 10);
const difference = (from, to) =>
  Math.round((Date.parse(to) - Date.parse(from)) / 86400000);
const bounded = (value, fallback, min, max) =>
  Number.isInteger(Number(value)) &&
  Number(value) >= min &&
  Number(value) <= max
    ? Number(value)
    : fallback;

function settings(options = {}) {
  return {
    window_days: bounded(options.window_days, 7, 3, 30),
    max_horizon_days: bounded(
      options.max_horizon_days ?? process.env.FORECAST_MAX_HORIZON_DAYS,
      60,
      1,
      60,
    ),
    max_data_age_days: bounded(
      options.max_data_age_days ?? process.env.FORECAST_MAX_DATA_AGE_DAYS,
      2,
      1,
      7,
    ),
  };
}

function project(context, options = {}) {
  const config = settings(options);
  const population = Number(context.cycle?.current_population);
  const base = {
    state: context.state,
    coop_id: context.coop?.id || null,
    flock_cycle_id: context.cycle?.id || null,
    source: context.source,
    is_simulated: context.source === "simulation",
    local_date: context.local_date || null,
    day_age: context.day_age ?? null,
    population_basis: Number.isFinite(population) ? population : null,
    planned_harvest_date: context.cycle?.planned_harvest_date || null,
    required_days: requiredDays,
    observed_days: { water_liters: 0, energy_kwh: 0 },
    eligible_days: { water_liters: 0, energy_kwh: 0 },
    method: "moving_average",
    confidence: "low",
    settings: config,
    generated_at: context.generated_at,
    forecasts: [],
    metrics: {},
    horizons: {},
    limitations: [
      "Estimates use observed tank-inlet water and aggregate-panel energy, not measured drinking intake or individual fan loads.",
      "Only completed farm-local calendar dates train the model; the current partial day is excluded.",
      "Current population and per-bird daily use are held constant; growth, mortality, weather and equipment changes are not invented.",
      "Accepted intervals establish availability but do not prove complete daily sampling; estimates may understate unobserved consumption.",
      "Confidence is qualitative and low; this method has not been validated as a biological consumption model.",
    ],
  };
  if (base.is_simulated)
    base.limitations.push(
      "This is an explicitly simulated dataset, separate from real sensor evidence.",
    );
  if (
    !context.coop ||
    !context.cycle ||
    context.state !== "ready" ||
    context.cycle.status !== "active"
  ) {
    base.reason = context.state === "ready" ? "no_active_cycle" : context.state;
    if (context.state === "ready") base.state = "no_active_cycle";
    return base;
  }
  const first = addDays(context.local_date, -config.window_days);
  const sameSource = (day) =>
    day.source === context.source &&
    (context.source === "simulation"
      ? day.data_quality === "simulated"
      : day.data_quality !== "simulated");
  const days = [
    ...new Map(
      (context.days || [])
        .filter(
          (day) =>
            sameSource(day) &&
            day.metric_date >= first &&
            day.metric_date <= context.local_date &&
            day.metric_date >= context.cycle.placement_date &&
            (day.flock_cycle_id == null ||
              String(day.flock_cycle_id) === String(context.cycle.id)) &&
            (day.coop_id == null ||
              String(day.coop_id) === String(context.coop.id)),
        )
        .map((day) => [day.metric_date, day]),
    ).values(),
  ].sort((a, b) => a.metric_date.localeCompare(b.metric_date));
  const snapshots = [];
  const expectations = {};
  for (const [metric, evidenceName] of [
    ["water_liters", "water_accepted_intervals"],
    ["energy_kwh", "electricity_accepted_intervals"],
  ]) {
    const observed = days.filter(
      (day) =>
        typeof day[metric] === "number" &&
        Number.isFinite(day[metric]) &&
        day[metric] >= 0 &&
        Number(day.evidence?.[evidenceName]) > 0 &&
        day.metric_status?.[metric] !== "not_available",
    );
    const eligible = observed.filter(
      (day) =>
        day.metric_date < context.local_date &&
        Number(day.population_basis) > 0,
    );
    const latest = eligible.at(-1)?.metric_date || null;
    const age = latest ? difference(latest, context.local_date) : null;
    const reason =
      population <= 0 || !Number.isFinite(population)
        ? "current_population_not_positive"
        : eligible.length < requiredDays
          ? "insufficient_completed_distinct_days"
          : age > config.max_data_age_days
            ? "stale_history"
            : null;
    const mean = reason
      ? null
      : eligible.reduce(
          (sum, day) => sum + day[metric] / Number(day.population_basis),
          0,
        ) / eligible.length;
    expectations[metric] = mean == null ? null : mean * population;
    base.observed_days[metric] = observed.length;
    base.eligible_days[metric] = eligible.length;
    base.metrics[metric] = {
      state: reason ? "insufficient_data" : "low_confidence",
      reason,
      observed_days: observed.length,
      eligible_days: eligible.length,
      required_days: requiredDays,
      input_dates: eligible.map((day) => day.metric_date),
      latest_input_date: latest,
      mean_per_bird_per_day: mean == null ? null : round(mean, 8),
      expected_daily_value: mean == null ? null : round(mean * population),
    };
    snapshots.push({
      metric,
      observed: observed
        .filter((day) => day.metric_date < context.local_date)
        .map((day) => ({
          date: day.metric_date,
          value: day[metric],
          population: day.population_basis,
          quality: day.data_quality,
          availability: day.metric_status?.[metric] || "partial",
        })),
    });
  }
  const planned = context.cycle.planned_harvest_date;
  const remaining =
    planned && Number.isFinite(Date.parse(planned))
      ? difference(context.local_date, planned)
      : null;
  base.remaining_days = remaining;
  const harvestReason = !planned
    ? "planned_harvest_date_missing"
    : remaining == null
      ? "planned_harvest_date_invalid"
      : remaining < 0
        ? "planned_harvest_date_in_past"
        : remaining > config.max_horizon_days
          ? "planned_harvest_exceeds_supported_horizon"
          : null;
  base.horizons.next_day = {
    state: "insufficient_data",
    target_date: addDays(context.local_date, 1),
    future_days: 1,
  };
  base.horizons.until_harvest = {
    state: harvestReason
      ? "invalid_harvest_horizon"
      : remaining === 0
        ? "no_remaining_future_days"
        : "insufficient_data",
    reason:
      harvestReason || (remaining === 0 ? "planned_harvest_is_today" : null),
    target_date: planned || null,
    future_days: remaining,
    interval:
      "Tomorrow through planned harvest date inclusive; excludes all of today and past consumption",
    operator_action: harvestReason
      ? "Review the planned harvest date manually; no cycle record has been changed"
      : null,
  };
  const electricityRate = context.farm?.electricity_rate_idr_per_kwh;
  const waterRate = context.farm?.water_rate_idr_per_m3;
  const validRate = (value) =>
    value != null && Number.isFinite(Number(value)) && Number(value) >= 0;
  for (const horizon of ["next_day", "until_harvest"]) {
    if (horizon === "until_harvest" && (harvestReason || remaining === 0))
      continue;
    const horizonDays = horizon === "next_day" ? 1 : remaining;
    for (const metric of ["water_liters", "energy_kwh"]) {
      const input = base.metrics[metric];
      if (input.state === "insufficient_data") continue;
      const predicted = round(expectations[metric] * horizonDays);
      if (!Number.isFinite(predicted) || predicted >= 100000000000000) {
        base.metrics[metric].state = "not_available";
        base.metrics[metric].reason = "projection_exceeds_storage_range";
        continue;
      }
      const details = {
        source: context.source,
        is_simulated: base.is_simulated,
        unit: metric === "water_liters" ? "liter" : "kwh",
        input_dates: input.input_dates,
        window_days: config.window_days,
        input_days: input.eligible_days,
        population_basis: population,
        population_assumption:
          "Current population held constant for future calendar days",
        mean_per_bird_per_day: input.mean_per_bird_per_day,
        future_days: horizonDays,
        training_cutoff: "Before the current farm-local date",
        method_version: "per-bird-moving-average-v1",
        formula:
          "mean(valid daily consumption / each day's population) * current population * future days",
        quality: base.is_simulated ? "simulated" : "partial",
        limitations: base.limitations,
      };
      if (metric === "water_liters")
        details.estimated_water_cost_idr = validRate(waterRate)
          ? round((predicted / 1000) * Number(waterRate))
          : null;
      const row = {
        metric,
        horizon,
        target_date: base.horizons[horizon].target_date,
        predicted_value: predicted,
        method: "moving_average",
        confidence: "low",
        input_days: input.eligible_days,
        details_json: details,
      };
      base.forecasts.push(row);
      if (metric === "energy_kwh" && validRate(electricityRate)) {
        const cost = round(predicted * Number(electricityRate));
        if (Number.isFinite(cost) && cost < 100000000000000)
          base.forecasts.push({
            ...row,
            metric: "electricity_cost_idr",
            predicted_value: cost,
            details_json: {
              ...details,
              unit: "idr",
              formula:
                "Projected panel energy kWh * current farm electricity tariff",
              electricity_rate_idr_per_kwh: Number(electricityRate),
              tariff_assumption:
                "Current configured tariff, without historical tariff versioning",
            },
          });
        else
          base.metrics.electricity_cost_idr = {
            state: "not_available",
            reason: "projection_exceeds_storage_range",
          };
      }
      base.horizons[horizon].state = "low_confidence";
    }
  }
  base.state = base.forecasts.length ? "low_confidence" : "insufficient_data";
  base.reason = base.forecasts.length
    ? "partial_coverage_and_constant_population_assumptions"
    : "Valid completed-date evidence is insufficient, stale, or cannot be normalized by population";
  base.input_fingerprint = crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        coop_id: base.coop_id,
        cycle: context.cycle,
        local_date: context.local_date,
        source: context.source,
        config,
        electricity_rate: electricityRate,
        water_rate: waterRate,
        observations: snapshots,
      }),
    )
    .digest("hex");
  return base;
}

module.exports = { project, settings };
