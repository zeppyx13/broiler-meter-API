const model = require("../models/ecoAdvisor.model");
const analytics = require("./analyticsContext.service");
const access = require("./access.service");
const engine = require("./ecoAdvisorEngine.service");
const httpError = require("../utils/httpError");

function evidence(row) {
  try {
    return typeof row.evidence_json === "string"
      ? JSON.parse(row.evidence_json)
      : row.evidence_json || {};
  } catch {
    return {};
  }
}

function present(row, current = new Set()) {
  const proof = evidence(row);
  return {
    ...row,
    evidence_json: proof,
    estimated_savings_idr:
      row.estimated_savings_idr == null
        ? null
        : Number(row.estimated_savings_idr),
    is_simulated: row.source === "simulation",
    is_current: current.has(proof.fingerprint),
  };
}

async function persist(context, connection, evaluated) {
  const rows = [];
  let created = 0;
  for (const recommendation of evaluated.recommendations) {
    let row = await model.findFingerprint(
      context.coop.id,
      context.cycle.id,
      recommendation.source,
      recommendation.fingerprint,
      connection,
    );
    if (!row) {
      row = await model.findById(
        await model.create(context, recommendation, connection),
        connection,
      );
      created++;
    } else {
      const previous = evidence(row);
      const { interaction, evidence_updated_at, ...material } = previous;
      if (
        JSON.stringify(material) !==
        JSON.stringify(recommendation.evidence_json)
      ) {
        const refreshed = {
          ...recommendation.evidence_json,
          ...(interaction ? { interaction } : {}),
          evidence_updated_at: context.generated_at,
        };
        await model.refreshEvidence(row.id, refreshed, connection);
        row = { ...row, evidence_json: refreshed };
      }
    }
    rows.push(
      present(
        row,
        new Set(evaluated.recommendations.map((item) => item.fingerprint)),
      ),
    );
  }
  return { rows, created };
}

function envelope(context, evaluated) {
  return {
    state: evaluated.state,
    coop_id: context.coop?.id || null,
    flock_cycle_id: context.cycle?.id || null,
    source: evaluated.source,
    is_simulated: evaluated.is_simulated,
    observed_days: evaluated.observed_days,
    required_days: evaluated.required_days,
    generated_at: context.generated_at,
    definitions: evaluated.definitions,
  };
}

async function list(user, query) {
  return analytics.withContext(user, query, async (context, connection) => {
    const evaluated = engine.evaluate(context);
    if (!context.coop)
      return {
        ...envelope(context, evaluated),
        recommendations: [],
        meta: { page: query.page, limit: query.limit, total: 0 },
      };
    await persist(context, connection, evaluated);
    const result = await model.list(context.coop.id, query, connection);
    const current = new Set(
      evaluated.recommendations.map((item) => item.fingerprint),
    );
    return {
      ...envelope(context, evaluated),
      recommendations: result.rows.map((row) => present(row, current)),
      meta: { page: query.page, limit: query.limit, total: result.total },
    };
  });
}

async function generate(user, input) {
  return analytics.withContext(user, input, async (context, connection) => {
    if (context.coop)
      await access.requireCoop(user, context.coop.id, "manage", connection);
    const evaluated = engine.evaluate(context);
    const result = await persist(context, connection, evaluated);
    return {
      ...envelope(context, evaluated),
      recommendations: result.rows,
      created_count: result.created,
      reused_count: result.rows.length - result.created,
    };
  });
}

async function setStatus(user, id, input) {
  const location = await model.location(id);
  if (!location) throw httpError(404, "Recommendation not found");
  return analytics.withContext(
    user,
    {
      coop_id: location.coop_id,
      source: location.source === "simulation" ? "simulation" : "real",
    },
    async (context, connection) => {
      await access.requireCoop(user, location.coop_id, "operate", connection);
      const row = await model.findById(id, connection);
      if (!row) throw httpError(404, "Recommendation not found");
      if (row.status !== input.status)
        await model.updateStatus(
          id,
          input.status,
          {
            ...evidence(row),
            interaction: {
              user_id: user.id,
              status: input.status,
              at: context.generated_at,
            },
          },
          connection,
        );
      const current = new Set(
        engine
          .evaluate(context)
          .recommendations.map((item) => item.fingerprint),
      );
      return {
        recommendation: present(await model.findById(id, connection), current),
      };
    },
  );
}

module.exports = { list, generate, setStatus, evaluate: engine.evaluate };
