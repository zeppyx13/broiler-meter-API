const { ok } = require("../utils/response");
const service = require("../services/farm.service");
const schema = require("../validators/farm.validator");

async function list(req, res) {
  return ok(
    res,
    await service.list(req.user, schema.listQuery.parse(req.query)),
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
    "Farm created",
    201,
  );
}

async function update(req, res) {
  const { id } = schema.idParam.parse(req.params);
  return ok(
    res,
    await service.update(req.user, id, schema.updateSchema.parse(req.body)),
    "Farm updated",
  );
}

async function remove(req, res) {
  const { id } = schema.idParam.parse(req.params);
  return ok(res, await service.remove(req.user, id), "Farm deactivated");
}

async function members(req, res) {
  const { id } = schema.idParam.parse(req.params);
  return ok(
    res,
    await service.members(req.user, id, schema.listQuery.parse(req.query)),
  );
}

async function addMember(req, res) {
  const { id } = schema.idParam.parse(req.params);
  const payload = schema.addMemberSchema.parse(req.body);
  return ok(
    res,
    await service.changeMember(
      req.user,
      id,
      payload.user_id,
      payload.role,
      "add",
    ),
    "Member added",
    201,
  );
}

async function updateMember(req, res) {
  const { id, userId } = schema.memberParam.parse(req.params);
  const payload = schema.updateMemberSchema.parse(req.body);
  return ok(
    res,
    await service.changeMember(req.user, id, userId, payload.role, "update"),
    "Member updated",
  );
}

async function removeMember(req, res) {
  const { id, userId } = schema.memberParam.parse(req.params);
  return ok(
    res,
    await service.changeMember(req.user, id, userId, null, "remove"),
    "Member removed",
  );
}

module.exports = {
  list,
  detail,
  create,
  update,
  remove,
  members,
  addMember,
  updateMember,
  removeMember,
};
