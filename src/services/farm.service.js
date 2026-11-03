const model = require("../models/farm.model");
const accessModel = require("../models/access.model");
const access = require("./access.service");
const withTransaction = require("../utils/transaction");
const httpError = require("../utils/httpError");

async function list(user, query) {
  return { farms: await model.list(user, query), meta: query };
}

async function detail(user, farmId) {
  return { farm: await access.requireFarm(user, farmId) };
}

async function create(user, data) {
  if (!["admin", "manager"].includes(user.role))
    throw httpError(403, "Only admin or manager may create farms");
  return withTransaction(async (connection) => {
    const farmId = await model.create(user.id, data, connection);
    await model.addMember(farmId, user.id, "owner", connection);
    return { farm: await access.requireFarm(user, farmId, "read", connection) };
  });
}

async function update(user, farmId, data) {
  return withTransaction(async (connection) => {
    await accessModel.lockFarm(farmId, connection);
    const farm = await access.requireFarm(user, farmId, "manage", connection);
    if (data.is_active === false) {
      await model.lockCoops(farmId, connection);
      if (await model.hasActiveCycles(farmId, connection))
        throw httpError(409, "Farm has an active flock cycle");
    }
    await model.update(farmId, { ...farm, ...data }, connection);
    return { farm: await access.requireFarm(user, farmId, "read", connection) };
  });
}

async function remove(user, farmId) {
  return update(user, farmId, { is_active: false });
}

async function members(user, farmId, query) {
  await access.requireFarm(user, farmId);
  return { members: await model.members(farmId, query), meta: query };
}

async function changeMember(user, farmId, userId, role, action) {
  return withTransaction(async (connection) => {
    await accessModel.lockFarm(farmId, connection);
    const farm = await access.requireFarm(user, farmId, "owner", connection);
    if (String(farm.owner_user_id) === String(userId))
      throw httpError(409, "Farm owner membership cannot be changed");
    if (!(await model.findUser(userId, connection)))
      throw httpError(404, "User not found");
    const existing = await model.findMember(farmId, userId, connection);
    if (existing?.role === "owner")
      throw httpError(409, "Owner membership cannot be changed");
    if (action === "add") {
      if (existing) throw httpError(409, "User is already a farm member");
      await model.addMember(farmId, userId, role, connection);
    } else {
      if (!existing) throw httpError(404, "Farm member not found");
      if (action === "remove") {
        await model.removeMember(farmId, userId, connection);
        await model.clearMemberDefault(farmId, userId, connection);
        return { removed: true, user_id: userId };
      }
      await model.updateMember(farmId, userId, role, connection);
    }
    return { member: await model.findMember(farmId, userId, connection) };
  });
}

module.exports = {
  list,
  detail,
  create,
  update,
  remove,
  members,
  changeMember,
};
