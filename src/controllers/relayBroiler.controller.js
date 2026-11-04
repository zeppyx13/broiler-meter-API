const { ok, fail } = require("../utils/response");
const service = require("../services/relayBroiler.service");
const schema = require("../validators/relayBroiler.validator");

async function list(req, res) {
  return ok(
    res,
    await service.list(req.user, schema.querySchema.parse(req.query)),
  );
}
async function detail(req, res) {
  const { id } = schema.idParam.parse(req.params);
  return ok(res, await service.detail(req.user, id));
}
async function create(req, res) {
  return ok(
    res,
    await service.create(req.user, schema.createSchema.parse(req.body)),
    "Relay paired",
    201,
  );
}
async function update(req, res) {
  const { id } = schema.idParam.parse(req.params);
  return ok(
    res,
    await service.update(req.user, id, schema.updateSchema.parse(req.body)),
    "Relay updated",
  );
}
async function remove(req, res) {
  const { id } = schema.idParam.parse(req.params);
  return ok(
    res,
    await service.update(req.user, id, { is_enabled: false }),
    "Relay disabled",
  );
}
async function commands(req, res) {
  const { id } = schema.idParam.parse(req.params);
  return ok(
    res,
    await service.commands(req.user, id, schema.listQuery.parse(req.query)),
  );
}
async function sendCommand(req, res) {
  const { id } = schema.idParam.parse(req.params);
  const result = await service.sendCommand(
    req.user,
    id,
    schema.commandSchema.parse(req.body),
  );
  if (result.command.status === "failed")
    return fail(
      res,
      "Relay command failed to publish; physical outcome is not confirmed",
      503,
      result,
    );
  if (result.command.status === "timed_out")
    return fail(
      res,
      "Relay publication timed out; this is not cancellation and physical execution may still occur",
      504,
      result,
    );
  return ok(
    res,
    result,
    "Command recorded; device acknowledgement is unavailable",
    202,
  );
}

module.exports = {
  list,
  detail,
  create,
  update,
  remove,
  commands,
  sendCommand,
};
