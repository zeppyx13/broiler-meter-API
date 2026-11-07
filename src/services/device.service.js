const model = require("../models/device.model");
const access = require("./access.service");
const withTransaction = require("../utils/transaction");
const httpError = require("../utils/httpError");
const { presentDevice } = require("../utils/deviceStatus");

async function list(user, query) {
  if (query.coop_id) await access.requireCoop(user, query.coop_id);
  return {
    devices: (await model.list(user, query)).map((row) => presentDevice(row)),
    meta: query,
  };
}

async function detail(user, id) {
  const device = await model.findById(id);
  if (!device) throw httpError(404, "Device not found");
  await access.requireCoop(user, device.coop_id);
  return { device: presentDevice(device) };
}

async function create(user, data) {
  return withTransaction(async (connection) => {
    await access.lockCoop(connection, data.coop_id);
    const coop = await access.requireCoop(
      user,
      data.coop_id,
      "owner",
      connection,
    );
    if (coop.status !== "active" || !coop.farm_is_active)
      throw httpError(409, "Coop or farm is inactive");
    const id = await model.create(data, connection);
    return { device: presentDevice(await model.findById(id, connection)) };
  });
}

async function update(user, id, data) {
  return withTransaction(async (connection) => {
    const existing = await model.findById(id, connection);
    if (!existing) throw httpError(404, "Device not found");
    await access.lockCoop(connection, existing.coop_id);
    const coop = await access.requireCoop(
      user,
      existing.coop_id,
      "owner",
      connection,
    );
    const device = await model.lockById(id, connection);
    if (
      data.is_active === true &&
      (coop.status !== "active" || !coop.farm_is_active)
    ) {
      throw httpError(409, "Coop or farm is inactive");
    }
    await model.update(id, { ...device, ...data }, connection);
    return { device: presentDevice(await model.findById(id, connection)) };
  });
}

async function remove(user, id) {
  return update(user, id, { is_active: false });
}

module.exports = { list, detail, create, update, remove };
