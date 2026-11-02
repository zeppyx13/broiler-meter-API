const facilityModel = require("../models/facility.model");

function httpError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

async function listFacilities() {
  const facilities = await facilityModel.findAll();
  return { facilities };
}

async function getFacilityDetail(id) {
  const facility = await facilityModel.findById(id);
  if (!facility) throw httpError("Facility not found", 404);
  return { facility };
}

async function createFacility(name) {
  const existing = await facilityModel.findByName(name);
  if (existing) throw httpError("Facility name already exists", 409);

  const id = await facilityModel.create(name);
  return getFacilityDetail(id);
}

async function updateFacility(id, name) {
  const existing = await facilityModel.findById(id);
  if (!existing) throw httpError("Facility not found", 404);

  const duplicate = await facilityModel.findByName(name);
  if (duplicate && duplicate.id !== id) {
    throw httpError("Facility name already exists", 409);
  }

  await facilityModel.updateById(id, name);
  return getFacilityDetail(id);
}

async function deleteFacility(id) {
  const existing = await facilityModel.findById(id);
  if (!existing) throw httpError("Facility not found", 404);

  await facilityModel.deleteFromRooms(id);
  await facilityModel.deleteById(id);
  return { deleted: true };
}

module.exports = {
  listFacilities,
  getFacilityDetail,
  createFacility,
  updateFacility,
  deleteFacility,
};
