const db = require("../config/db");

async function findFingerprint(
  coopId,
  cycleId,
  source,
  fingerprint,
  connection,
) {
  const [[row]] = await connection.query(
    `SELECT * FROM eco_recommendations WHERE coop_id = ? AND flock_cycle_id <=> ? AND source = ?
     AND JSON_UNQUOTE(JSON_EXTRACT(evidence_json, '$.fingerprint')) = ? ORDER BY id DESC LIMIT 1`,
    [coopId, cycleId, source, fingerprint],
  );
  return row || null;
}

async function create(context, data, connection) {
  const [result] = await connection.query(
    `INSERT INTO eco_recommendations (coop_id, flock_cycle_id, category, priority, title, description,
       estimated_savings_idr, evidence_json, source, status, generated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?)`,
    [
      context.coop.id,
      context.cycle.id,
      data.category,
      data.priority,
      data.title,
      data.description,
      data.estimated_savings_idr,
      JSON.stringify(data.evidence_json),
      data.source,
      new Date(context.generated_at),
    ],
  );
  return result.insertId;
}

async function findById(id, connection = db) {
  const [[row]] = await connection.query(
    "SELECT * FROM eco_recommendations WHERE id = ?",
    [id],
  );
  return row || null;
}

async function location(id) {
  const [[row]] = await db.query(
    "SELECT coop_id, source FROM eco_recommendations WHERE id = ?",
    [id],
  );
  return row || null;
}

async function list(coopId, query, connection) {
  const values = [
    coopId,
    query.source === "simulation" ? "simulation" : "rule",
    query.status || null,
    query.status || null,
    query.category || null,
    query.category || null,
  ];
  const [rows] = await connection.query(
    `SELECT * FROM eco_recommendations WHERE coop_id = ? AND source = ?
       AND (? IS NULL OR status = ?) AND (? IS NULL OR category = ?)
     ORDER BY generated_at DESC, id DESC LIMIT ? OFFSET ?`,
    [...values, query.limit, (query.page - 1) * query.limit],
  );
  const [[count]] = await connection.query(
    `SELECT COUNT(*) AS total FROM eco_recommendations WHERE coop_id = ? AND source = ?
       AND (? IS NULL OR status = ?) AND (? IS NULL OR category = ?)`,
    values,
  );
  return { rows, total: Number(count.total) };
}

async function updateStatus(id, status, evidence, connection) {
  await connection.query(
    "UPDATE eco_recommendations SET status = ?, evidence_json = ? WHERE id = ?",
    [status, JSON.stringify(evidence), id],
  );
}

async function refreshEvidence(id, evidence, connection) {
  await connection.query(
    "UPDATE eco_recommendations SET evidence_json = ? WHERE id = ?",
    [JSON.stringify(evidence), id],
  );
}

module.exports = {
  findFingerprint,
  create,
  findById,
  location,
  list,
  updateStatus,
  refreshEvidence,
};
