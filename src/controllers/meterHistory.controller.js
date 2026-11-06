const service = require("../services/meterHistory.service");
const validator = require("../validators/meterHistory.validator");
const { ok } = require("../utils/response");

async function list(req, res) {
  const { id } = validator.idParams.parse(req.params);
  return ok(
    res,
    await service.list(req.user, id, validator.querySchema.parse(req.query)),
  );
}
module.exports = { list };
