const { ok } = require("../utils/response");
const userService = require("../services/user.service");
const { updateMeSchema } = require("../validators/user.validator");

async function updateMe(req, res, next) {
  try {
    const payload = updateMeSchema.parse(req.body);
    const result = await userService.updateMe(req.user.id, payload);
    return ok(res, result, "Profile updated", 200);
  } catch (err) {
    return next(err);
  }
}

async function getAllUsers(req, res, next) {
  try {
    const result = await userService.getAllUsers();
    return ok(res, result, "Users retrieved", 200);
  } catch (err) {
    return next(err);
  }
}

async function getAdminUsers(req, res, next) {
  try {
    const result = await userService.getAdminUsers();
    return ok(res, result, "Admin users retrieved", 200);
  } catch (err) {
    return next(err);
  }
}
module.exports = { updateMe, getAllUsers, getAdminUsers };
