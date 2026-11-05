const analytics = require("./analyticsContext.service");
const access = require("./access.service");
const model = require("../models/forecast.model");
const { project } = require("./forecastEngine.service");

function present(row) {
  let details;
  try {
    details =
      typeof row.details_json === "string"
        ? JSON.parse(row.details_json)
        : row.details_json;
  } catch {
    details = {};
  }
  return {
    ...row,
    predicted_value: Number(row.predicted_value),
    is_simulated: Boolean(row.is_simulated),
    source: row.is_simulated ? "simulation" : "real",
    details_json: details,
  };
}
async function calculate(context, connection, options) {
  const result = project(context, options);
  if (!context.cycle || context.state !== "ready")
    return {
      ...result,
      cache_status: "not_applicable",
      as_of: context.generated_at,
    };
  const key = `forecast:v1:${context.coop.id}:${context.cycle.id}:${context.source}:${result.input_fingerprint}`;
  const cached = await model.cache(key, connection);
  if (
    cached &&
    new Date(cached.expires_at).getTime() > Date.parse(context.generated_at)
  ) {
    let stored;
    try {
      stored = JSON.parse(cached.result_json);
    } catch {
      stored = null;
    }
    if (stored?.input_fingerprint === result.input_fingerprint)
      return {
        ...result,
        forecasts: stored.forecasts,
        generated_at: stored.generated_at,
        cache_status: "reused_same_inputs",
        as_of: context.generated_at,
      };
  }
  const forecasts = [];
  for (const row of result.forecasts) {
    const record = {
      ...row,
      details_json: {
        ...row.details_json,
        input_fingerprint: result.input_fingerprint,
      },
    };
    const id = await model.create(context, record, connection);
    forecasts.push({
      ...record,
      id,
      coop_id: context.coop.id,
      flock_cycle_id: context.cycle.id,
      is_simulated: context.source === "simulation",
      source: context.source,
      generated_at: context.generated_at,
    });
  }
  const output = {
    ...result,
    forecasts,
    cache_status: "generated",
    as_of: context.generated_at,
  };
  await model.saveCache(context, key, output, connection);
  return output;
}
function current(user, query) {
  return analytics.withContext(user, query, (context, connection) =>
    calculate(context, connection, query),
  );
}
function generate(user, payload) {
  return analytics.withContext(user, payload, async (context, connection) => {
    if (context.coop)
      await access.requireCoop(user, context.coop.id, "manage", connection);
    return calculate(context, connection, payload);
  });
}
function history(user, query) {
  return analytics.withContext(user, query, async (context, connection) => {
    if (!context.coop)
      return {
        state: "no_coop",
        source: query.source,
        forecasts: [],
        meta: { page: query.page, limit: query.limit, total: 0 },
      };
    const result = await model.history(context.coop.id, query, connection);
    return {
      state: "ready",
      coop_id: context.coop.id,
      source: query.source,
      forecasts: result.rows.map(present),
      meta: { page: query.page, limit: query.limit, total: result.total },
    };
  });
}

module.exports = { current, generate, history };
