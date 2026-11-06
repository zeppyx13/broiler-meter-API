const { ok } = require("../utils/response");
const service = require("../services/copilotBroiler.service");
const schema = require("../validators/copilotBroiler.validator");

async function list(req, res) {
  return ok(
    res,
    await service.list(req.user, schema.listQuery.parse(req.query)),
  );
}
async function create(req, res) {
  return ok(
    res,
    await service.create(req.user, schema.createSchema.parse(req.body)),
    "Conversation created",
    201,
  );
}
async function detail(req, res) {
  return ok(
    res,
    await service.detail(req.user, schema.idParam.parse(req.params).id),
  );
}
async function messages(req, res) {
  return ok(
    res,
    await service.messages(
      req.user,
      schema.idParam.parse(req.params).id,
      schema.messagesQuery.parse(req.query),
    ),
  );
}
async function send(req, res) {
  return ok(
    res,
    await service.send(req.user, schema.sendSchema.parse(req.body)),
    "Copilot request processed",
  );
}

module.exports = { list, create, detail, messages, send };
