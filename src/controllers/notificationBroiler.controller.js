const { ok } = require("../utils/response");
const service = require("../services/notificationBroiler.service");
const schema = require("../validators/notificationBroiler.validator");

async function list(req, res) {
  return ok(
    res,
    await service.list(req.user, schema.querySchema.parse(req.query)),
  );
}

async function unread(req, res) {
  return ok(
    res,
    await service.unread(req.user, schema.scopeQuery.parse(req.query)),
  );
}

async function read(req, res) {
  const { id } = schema.idParam.parse(req.params);
  schema.emptyBody.parse(req.body || {});
  return ok(
    res,
    await service.read(req.user, id, req.app.get("io")),
    "Notification read",
  );
}

async function readAll(req, res) {
  schema.emptyBody.parse(req.body || {});
  return ok(
    res,
    await service.readAll(req.user, schema.scopeQuery.parse(req.query)),
    "Notifications read",
  );
}

module.exports = { list, unread, read, readAll };
