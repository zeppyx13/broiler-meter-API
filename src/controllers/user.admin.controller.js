const { ok, fail } = require("../utils/response");
const userAdminService = require("../services/user.admin.service");
const {
  userIdParamSchema,
  updateUserAdminSchema,
  listUsersQuerySchema,
} = require("../validators/user.admin.validator");

async function list(req, res, next) {
  try {
    const query = listUsersQuerySchema.parse(req.query);
    const result = await userAdminService.listUsers(query);
    return ok(res, result, "OK", 200);
  } catch (err) {
    return next(err);
  }
}

async function detail(req, res, next) {
  try {
    const { id } = userIdParamSchema.parse(req.params);
    const result = await userAdminService.getUserDetail(id);
    return ok(res, result, "OK", 200);
  } catch (err) {
    return next(err);
  }
}

async function update(req, res, next) {
  try {
    const { id } = userIdParamSchema.parse(req.params);
    const payload = updateUserAdminSchema.parse(req.body);
    const result = await userAdminService.updateUser(id, payload);
    return ok(res, result, "User updated", 200);
  } catch (err) {
    return next(err);
  }
}

async function remove(req, res, next) {
  try {
    const { id } = userIdParamSchema.parse(req.params);

    // Cegah admin hapus akunnya sendiri
    if (Number(id) === Number(req.user.id)) {
      return fail(res, "Cannot delete your own account", 400);
    }

    const result = await userAdminService.deleteUser(id);
    return ok(res, result, "User deleted", 200);
  } catch (err) {
    return next(err);
  }
}

module.exports = { list, detail, update, remove };
