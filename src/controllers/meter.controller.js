const { ok, fail } = require("../utils/response");
const meterService = require("../services/meter.service");
const {
  createMeterSchema,
  updateMeterSchema,
  meterIdParamSchema,
  listMetersQuerySchema,
} = require("../validators/meter.validator");

async function list(req, res) {
  try {
    const query = listMetersQuerySchema.parse(req.query);
    const result = await meterService.listMeters(query);
    return ok(res, result, "OK", 200);
  } catch (err) {
    return fail(res, err.message, err.statusCode || 500);
  }
}

async function detail(req, res) {
  try {
    const { id } = meterIdParamSchema.parse(req.params);
    const result = await meterService.getMeterDetail(id);
    return ok(res, result, "OK", 200);
  } catch (err) {
    return fail(res, err.message, err.statusCode || 400);
  }
}

async function create(req, res) {
  try {
    const payload = createMeterSchema.parse(req.body);
    const result = await meterService.createMeter(payload);
    return ok(res, result, "Meter created", 201);
  } catch (err) {
    return fail(res, err.message, err.statusCode || 400);
  }
}

async function update(req, res) {
  try {
    const { id } = meterIdParamSchema.parse(req.params);
    const payload = updateMeterSchema.parse(req.body);
    const result = await meterService.updateMeter(id, payload);
    return ok(res, result, "Meter updated", 200);
  } catch (err) {
    return fail(res, err.message, err.statusCode || 400);
  }
}

async function remove(req, res) {
  try {
    const { id } = meterIdParamSchema.parse(req.params);
    const result = await meterService.deleteMeter(id);
    return ok(res, result, "Meter deleted", 200);
  } catch (err) {
    return fail(res, err.message, err.statusCode || 400);
  }
}

module.exports = { list, detail, create, update, remove };
