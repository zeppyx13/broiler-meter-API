const { ok } = require("../utils/response");
const service = require("../services/coop.service");
const schema = require("../validators/coop.validator");

async function list(req, res) {
  return ok(res, await service.list(req.user, schema.querySchema.parse(req.query)));
}

async function detail(req, res) {
  const { id } = schema.idParam.parse(req.params);
  return ok(res, await service.detail(req.user, id));
}

async function create(req, res) {
  return ok(res, await service.create(req.user, schema.createSchema.parse(req.body)), "Coop created", 201);
}

async function update(req, res) {
  const { id } = schema.idParam.parse(req.params);
  return ok(res, await service.update(req.user, id, schema.updateSchema.parse(req.body)), "Coop updated");
}

async function remove(req, res) {
  const { id } = schema.idParam.parse(req.params);
  return ok(res, await service.remove(req.user, id), "Coop deactivated");
}

module.exports = { list, detail, create, update, remove };
