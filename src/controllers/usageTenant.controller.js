const { ok, fail } = require("../utils/response");
const usageTenantService = require("../services/usageTenant.service");
const {
  myUsageQuerySchema,
  myMeterReadingsQuerySchema,
} = require("../validators/usage.validator");

async function myUsage(req, res) {
  try {
    const query = myUsageQuerySchema.parse(req.query);
    const result = await usageTenantService.getMyUsageMonthly(
      req.user.id,
      query.month,
    );
    return ok(res, result, "OK", 200);
  } catch (err) {
    return fail(res, err.message, err.statusCode || 400);
  }
}

async function myMeterReadings(req, res) {
  try {
    const query = myMeterReadingsQuerySchema.parse(req.query);
    const result = await usageTenantService.getMyMeterReadings(
      req.user.id,
      query,
    );
    return ok(res, result, "OK", 200);
  } catch (err) {
    return fail(res, err.message, err.statusCode || 400);
  }
}

module.exports = { myUsage, myMeterReadings };
