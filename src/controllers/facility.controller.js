const { ok, fail } = require("../utils/response");
const facilityService = require("../services/facility.service");
const {
  createFacilitySchema,
  updateFacilitySchema,
  facilityIdParamSchema,
} = require("../validators/facility.validator");

async function list(req, res) {
  try {
    const result = await facilityService.listFacilities();
    return ok(res, result, "OK", 200);
  } catch (err) {
    return fail(res, err.message, err.statusCode || 500);
  }
}

async function detail(req, res) {
  try {
    const { id } = facilityIdParamSchema.parse(req.params);
    const result = await facilityService.getFacilityDetail(id);
    return ok(res, result, "OK", 200);
  } catch (err) {
    return fail(res, err.message, err.statusCode || 400);
  }
}

async function create(req, res) {
  try {
    const { name } = createFacilitySchema.parse(req.body);
    const result = await facilityService.createFacility(name);
    return ok(res, result, "Facility created", 201);
  } catch (err) {
    return fail(res, err.message, err.statusCode || 400);
  }
}

async function update(req, res) {
  try {
    const { id } = facilityIdParamSchema.parse(req.params);
    const { name } = updateFacilitySchema.parse(req.body);
    const result = await facilityService.updateFacility(id, name);
    return ok(res, result, "Facility updated", 200);
  } catch (err) {
    return fail(res, err.message, err.statusCode || 400);
  }
}

async function remove(req, res) {
  try {
    const { id } = facilityIdParamSchema.parse(req.params);
    const result = await facilityService.deleteFacility(id);
    return ok(res, result, "Facility deleted", 200);
  } catch (err) {
    return fail(res, err.message, err.statusCode || 400);
  }
}

module.exports = { list, detail, create, update, remove };
