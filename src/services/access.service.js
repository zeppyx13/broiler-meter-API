const db = require("../config/db");
const model = require("../models/access.model");
const httpError = require("../utils/httpError");

function authorize(user, resource, capability) {
  if (!resource) throw httpError(404, "Resource not found");
  if (user.role === "admin") return;
  const allowed = {
    read: ["owner", "manager", "operator", "viewer"],
    operate: ["owner", "manager", "operator"],
    manage: ["owner", "manager"],
    owner: ["owner"],
  };
  if (!allowed[capability]?.includes(resource.member_role)) {
    throw httpError(403, "Farm access denied");
  }
}

async function requireFarm(user, farmId, capability = "read", connection = db) {
  const farm = await model.farmForUser(user.id, farmId, connection);
  authorize(user, farm, capability);
  if (capability === "operate" && !farm.is_active)
    throw httpError(409, "Farm is inactive");
  return farm;
}

async function requireCoop(user, coopId, capability = "read", connection = db) {
  const coop = await model.coopForUser(user.id, coopId, connection);
  authorize(user, coop, capability);
  if (
    capability === "operate" &&
    (!coop.farm_is_active || coop.status !== "active")
  ) {
    throw httpError(409, "Coop or farm is inactive");
  }
  return coop;
}

// All mutations use this order, including flock-cycle writers: farm -> coop -> cycle.
async function lockCoop(connection, coopId) {
  const existing = await model.findCoop(coopId, connection);
  if (!existing) throw httpError(404, "Coop not found");
  await model.lockFarm(existing.farm_id, connection);
  return model.lockCoop(coopId, connection);
}

async function resolveDefaultCoop(user, connection = db) {
  const current = await model.findDefaultCoop(user, connection);
  if (current) return current;
  const fallback = await model.firstAccessibleCoop(user, connection);
  await model.setDefaultCoop(user.id, fallback?.id || null, connection);
  return fallback;
}

module.exports = { requireFarm, requireCoop, lockCoop, resolveDefaultCoop };
