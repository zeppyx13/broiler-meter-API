const db = require("../config/db");

async function cache(key, connection) {
  const [[row]] = await connection.query(
    "SELECT result_json,generated_at,expires_at FROM ai_cache WHERE cache_key=? AND type='prediction'",
    [key],
  );
  return row || null;
}
async function saveCache(context, key, result, connection) {
  const now = new Date(context.generated_at);
  await connection.query(
    `INSERT INTO ai_cache (coop_id,flock_cycle_id,type,cache_key,result_json,generated_at,expires_at)
     VALUES (?,?,'prediction',?,?,?,?) ON DUPLICATE KEY UPDATE result_json=VALUES(result_json),generated_at=VALUES(generated_at),expires_at=VALUES(expires_at)`,
    [
      context.coop.id,
      context.cycle.id,
      key,
      JSON.stringify(result),
      now,
      new Date(now.getTime() + 48 * 3600000),
    ],
  );
}
async function create(context, forecast, connection) {
  const [row] = await connection.query(
    `INSERT INTO forecasts (coop_id,flock_cycle_id,metric,horizon,target_date,predicted_value,method,confidence,input_days,details_json,is_simulated,generated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      context.coop.id,
      context.cycle.id,
      forecast.metric,
      forecast.horizon,
      forecast.target_date,
      forecast.predicted_value,
      forecast.method,
      forecast.confidence,
      forecast.input_days,
      JSON.stringify(forecast.details_json),
      context.source === "simulation",
      new Date(context.generated_at),
    ],
  );
  return row.insertId;
}
async function history(coopId, query, connection = db) {
  const [rows] = await connection.query(
    `SELECT f.*,DATE_FORMAT(target_date,'%Y-%m-%d') AS target_date FROM forecasts f
     WHERE coop_id=? AND is_simulated=? AND (? IS NULL OR metric=?) AND (? IS NULL OR horizon=?)
       AND (? IS NULL OR flock_cycle_id=?)
     ORDER BY generated_at DESC,id DESC LIMIT ? OFFSET ?`,
    [
      coopId,
      query.source === "simulation",
      query.metric || null,
      query.metric || null,
      query.horizon || null,
      query.horizon || null,
      query.flock_cycle_id || null,
      query.flock_cycle_id || null,
      query.limit,
      (query.page - 1) * query.limit,
    ],
  );
  const [[{ total }]] = await connection.query(
    `SELECT COUNT(*) AS total FROM forecasts
     WHERE coop_id=? AND is_simulated=? AND (? IS NULL OR metric=?) AND (? IS NULL OR horizon=?)
       AND (? IS NULL OR flock_cycle_id=?)`,
    [
      coopId,
      query.source === "simulation",
      query.metric || null,
      query.metric || null,
      query.horizon || null,
      query.horizon || null,
      query.flock_cycle_id || null,
      query.flock_cycle_id || null,
    ],
  );
  return { rows, total: Number(total) };
}

module.exports = { cache, saveCache, create, history };
