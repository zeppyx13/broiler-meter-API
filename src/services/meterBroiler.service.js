const model = require("../models/meterBroiler.model");
const devices = require("../models/device.model");
const access = require("./access.service");
const withTransaction = require("../utils/transaction");
const httpError = require("../utils/httpError");

async function list(user, query) {
  if (query.coop_id) await access.requireCoop(user, query.coop_id);
  if (query.device_id) {
    const device = await devices.findById(query.device_id);
    if (!device) throw httpError(404, "Device not found");
    await access.requireCoop(user, device.coop_id);
  }
  return { meters: await model.list(user, query), meta: query };
}

async function detail(user, id) {
  const meter = await model.findById(id);
  if (!meter) throw httpError(404, "Meter not found");
  const device = await devices.findById(meter.device_id);
  await access.requireCoop(user, device.coop_id);
  return {
    meter: {
      ...meter,
      coop_id: device.coop_id,
      device_is_active: device.is_active,
    },
  };
}

function ensureNonOverlappingChannel(channel, rows) {
  const aggregate = ["main", "total"].includes(channel);
  if (
    rows.some(
      (row) =>
        row.channel === channel ||
        aggregate ||
        ["main", "total"].includes(row.channel),
    )
  ) {
    throw httpError(
      409,
      "Electrical channels must be one main/total meter or separate phases, without overlap",
    );
  }
}

async function create(user, data) {
  return withTransaction(async (connection) => {
    const existing = await devices.findById(data.device_id, connection);
    if (!existing) throw httpError(404, "Device not found");
    await access.lockCoop(connection, existing.coop_id);
    const coop = await access.requireCoop(
      user,
      existing.coop_id,
      "owner",
      connection,
    );
    const device = await devices.lockById(data.device_id, connection);
    if (!device.is_active || coop.status !== "active" || !coop.farm_is_active) {
      throw httpError(409, "Device, coop or farm is inactive");
    }
    if (data.type === "electricity") {
      ensureNonOverlappingChannel(
        data.channel,
        await model.electricalChannels(data.device_id, connection),
      );
    }
    const id = await model.create(data, connection);
    return { meter: await model.lockById(id, connection) };
  });
}

async function update(user, id, data) {
  return withTransaction(async (connection) => {
    const existing = await model.findById(id, connection);
    if (!existing) throw httpError(404, "Meter not found");
    const existingDevice = await devices.findById(
      existing.device_id,
      connection,
    );
    await access.lockCoop(connection, existingDevice.coop_id);
    const coop = await access.requireCoop(
      user,
      existingDevice.coop_id,
      "owner",
      connection,
    );
    const device = await devices.lockById(existing.device_id, connection);
    const meter = await model.lockById(id, connection);
    if (
      data.is_active === true &&
      (!device.is_active || coop.status !== "active" || !coop.farm_is_active)
    ) {
      throw httpError(409, "Device, coop or farm is inactive");
    }
    await model.update(id, { ...meter, ...data }, connection);
    return { meter: await model.lockById(id, connection) };
  });
}

async function remove(user, id) {
  return update(user, id, { is_active: false });
}

module.exports = { list, detail, create, update, remove };
