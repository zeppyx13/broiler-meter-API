const meterModel = require("../models/meter.model");

function httpError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

async function listMeters(query) {
  const meters = await meterModel.findAll(query);
  return { meters };
}

async function getMeterDetail(id) {
  const meter = await meterModel.findById(id);
  if (!meter) throw httpError("Meter not found", 404);
  return { meter };
}

async function createMeter(payload) {
  // Cek device_uid unik
  const existingUid = await meterModel.findByDeviceUid(payload.device_uid);
  if (existingUid) throw httpError("Device UID already registered", 409);

  // Cek kombinasi room + type unik
  const existingRoomType = await meterModel.findByRoomAndType(
    payload.room_id,
    payload.type,
  );
  if (existingRoomType) {
    throw httpError(`Room already has a ${payload.type} meter`, 409);
  }

  const id = await meterModel.create(payload);
  return getMeterDetail(id);
}

async function updateMeter(id, payload) {
  const existing = await meterModel.findById(id);
  if (!existing) throw httpError("Meter not found", 404);

  // Cek device_uid tidak bentrok dengan meter lain
  if (payload.device_uid) {
    const duplicate = await meterModel.findByDeviceUid(payload.device_uid);
    if (duplicate && duplicate.id !== id) {
      throw httpError("Device UID already registered", 409);
    }
  }

  await meterModel.updateById(id, payload);
  return getMeterDetail(id);
}

async function deleteMeter(id) {
  const existing = await meterModel.findById(id);
  if (!existing) throw httpError("Meter not found", 404);
  await meterModel.deleteById(id);
  return { deleted: true };
}

module.exports = {
  listMeters,
  getMeterDetail,
  createMeter,
  updateMeter,
  deleteMeter,
};
