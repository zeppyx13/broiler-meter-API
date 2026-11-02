const userAdminModel = require("../models/user.admin.model");

function httpError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

async function listUsers(query) {
  const result = await userAdminModel.findAll(query);
  return {
    users: result.rows,
    meta: { total: result.total, page: result.page, limit: result.limit },
  };
}

async function getUserDetail(id) {
  const user = await userAdminModel.findById(id);
  if (!user) throw httpError("User not found", 404);
  return { user };
}

async function updateUser(id, payload) {
  const existing = await userAdminModel.findById(id);
  if (!existing) throw httpError("User not found", 404);
  await userAdminModel.updateById(id, payload);
  return getUserDetail(id);
}

async function deleteUser(id) {
  const existing = await userAdminModel.findById(id);
  if (!existing) throw httpError("User not found", 404);

  // Cegah hapus diri sendiri — cek di controller lewat req.user.id
  await userAdminModel.deleteById(id);
  return { deleted: true };
}

module.exports = { listUsers, getUserDetail, updateUser, deleteUser };
