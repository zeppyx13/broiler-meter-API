const service = require("../services/guard.service");
const schema = require("../validators/guard.validator");
const { ok } = require("../utils/response");

async function listRules(req, res) {
  return ok(
    res,
    await service.listRules(req.user, schema.listQuery.parse(req.query)),
  );
}
async function getRule(req, res) {
  return ok(
    res,
    await service.getRule(req.user, schema.idParams.parse(req.params).id),
  );
}
async function createRule(req, res) {
  return ok(
    res,
    await service.createRule(req.user, schema.createSchema.parse(req.body)),
    "Guard rule created",
    201,
  );
}
async function updateRule(req, res) {
  return ok(
    res,
    await service.updateRule(
      req.user,
      schema.idParams.parse(req.params).id,
      schema.updateSchema.parse(req.body),
    ),
    "Guard rule updated",
  );
}
async function listAlerts(req, res) {
  return ok(
    res,
    await service.listAlerts(req.user, schema.alertsQuery.parse(req.query)),
  );
}
async function getAlert(req, res) {
  return ok(
    res,
    await service.getAlert(req.user, schema.idParams.parse(req.params).id),
  );
}
async function acknowledge(req, res) {
  const { id } = schema.idParams.parse(req.params);
  schema.ackSchema.parse(req.body || {});
  return ok(
    res,
    await service.acknowledge(req.user, id, { io: req.app.get("io") }),
    "Alert acknowledged",
  );
}
async function resolve(req, res) {
  const { id } = schema.idParams.parse(req.params);
  const { note } = schema.resolveSchema.parse(req.body);
  return ok(
    res,
    await service.resolve(req.user, id, note, { io: req.app.get("io") }),
    "Alert resolved with operator audit",
  );
}
async function status(req, res) {
  return ok(
    res,
    await service.status(req.user, schema.statusQuery.parse(req.query)),
  );
}

module.exports = {
  listRules,
  getRule,
  createRule,
  updateRule,
  listAlerts,
  getAlert,
  acknowledge,
  resolve,
  status,
};
