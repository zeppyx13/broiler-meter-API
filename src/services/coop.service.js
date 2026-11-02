const model = require("../models/coop.model");
const accessModel = require("../models/access.model");
const access = require("./access.service");
const withTransaction = require("../utils/transaction");
const httpError = require("../utils/httpError");

async function list(user, query) {
  if (query.farm_id) await access.requireFarm(user, query.farm_id);
  return { coops: await model.list(user, query), meta: query };
}

async function detail(user, coopId) {
  return { coop: await access.requireCoop(user, coopId) };
}

async function create(user, data) {
  return withTransaction(async (connection) => {
    await accessModel.lockFarm(data.farm_id, connection);
    const farm = await access.requireFarm(user, data.farm_id, "manage", connection);
    if (!farm.is_active) throw httpError(409, "Farm is inactive");
    const coopId = await model.create(data, connection);
    await accessModel.lockUser(user.id, connection);
    await access.resolveDefaultCoop(user, connection);
    return { coop: await access.requireCoop(user, coopId, "read", connection) };
  });
}

async function update(user, coopId, data) {
  return withTransaction(async (connection) => {
    await access.lockCoop(connection, coopId);
    const coop = await access.requireCoop(user, coopId, "manage", connection);
    const active = await model.activeCycle(coopId, connection);
    if (data.status === "active" && !coop.farm_is_active) throw httpError(409, "Farm is inactive");
    if (active && data.status === "inactive") throw httpError(409, "Coop has an active flock cycle");
    if (active && data.capacity_birds != null && data.capacity_birds < Number(active.current_population)) {
      throw httpError(409, "Capacity is below the active flock population");
    }
    await model.update(coopId, { ...coop, ...data }, connection);
    return { coop: await access.requireCoop(user, coopId, "read", connection) };
  });
}

async function remove(user, coopId) {
  return update(user, coopId, { status: "inactive" });
}

module.exports = { list, detail, create, update, remove };
