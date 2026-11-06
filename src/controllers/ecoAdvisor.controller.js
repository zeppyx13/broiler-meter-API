const { ok } = require("../utils/response");
const service = require("../services/ecoAdvisor.service");
const schema = require("../validators/ecoAdvisor.validator");

async function list(req, res) {
  return ok(
    res,
    await service.list(req.user, schema.querySchema.parse(req.query)),
  );
}

async function generate(req, res) {
  return ok(
    res,
    await service.generate(req.user, schema.scopeSchema.parse(req.body || {})),
    "Advisor evaluated",
  );
}

async function setStatus(req, res) {
  const { id } = schema.idParam.parse(req.params);
  return ok(
    res,
    await service.setStatus(req.user, id, schema.statusSchema.parse(req.body)),
    "Recommendation status updated",
  );
}

module.exports = { list, generate, setStatus };
