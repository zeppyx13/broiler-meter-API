const { ok, fail } = require("../utils/response");
const tenantService = require("../services/tenant.service");

async function myRoom(req, res) {
  try {
    const result = await tenantService.getMyRoom(req.user.id);
    return ok(res, result, "OK", 200);
  } catch (err) {
    return fail(res, err.message, err.statusCode || 400);
  }
}

module.exports = { myRoom };
