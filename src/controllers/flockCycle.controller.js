const service = require("../services/flockCycle.service");
const validator = require("../validators/flockCycle.validator");
const { ok } = require("../utils/response");

async function create(req, res) {
  return ok(
    res,
    await service.create(req.user, validator.createSchema.parse(req.body)),
    "Cycle created",
    201,
  );
}
async function active(req, res) {
  const query = validator.coopQuery.parse(req.query);
  return ok(res, { cycle: await service.active(req.user, query.coop_id) });
}
async function list(req, res) {
  return ok(res, {
    cycles: await service.list(req.user, validator.listQuery.parse(req.query)),
  });
}
async function get(req, res) {
  const { id } = validator.idParams.parse(req.params);
  return ok(res, { cycle: await service.get(req.user, id) });
}
async function recordEvent(req, res) {
  const { id } = validator.idParams.parse(req.params);
  return ok(
    res,
    await service.recordEvent(
      req.user,
      id,
      validator.eventSchema.parse(req.body),
    ),
    "Event recorded",
    201,
  );
}
async function events(req, res) {
  const { id } = validator.idParams.parse(req.params);
  return ok(res, { events: await service.events(req.user, id) });
}
async function complete(req, res) {
  const { id } = validator.idParams.parse(req.params);
  return ok(res, {
    cycle: await service.complete(
      req.user,
      id,
      validator.completeSchema.parse(req.body || {}),
    ),
  });
}

module.exports = { create, active, list, get, recordEvent, events, complete };
