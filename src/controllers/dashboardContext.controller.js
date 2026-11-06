const service = require("../services/dashboardContext.service");
const { ok } = require("../utils/response");

async function get(req, res) {
  return ok(res, await service.get(req.user));
}

module.exports = { get };
