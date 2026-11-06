const service = require("../services/forecast.service");
const schema = require("../validators/forecast.validator");
const { ok } = require("../utils/response");
async function current(req, res) {
  return ok(
    res,
    await service.current(req.user, schema.querySchema.parse(req.query)),
  );
}
async function history(req, res) {
  return ok(
    res,
    await service.history(req.user, schema.historySchema.parse(req.query)),
  );
}
async function generate(req, res) {
  return ok(
    res,
    await service.generate(
      req.user,
      schema.generateSchema.parse(req.body || {}),
    ),
    "Forecast evaluated",
  );
}
module.exports = { current, history, generate };
