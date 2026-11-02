const userModel = require("../models/user.model");

async function updateMe(userId, payload) {
  await userModel.updateById(userId, payload);
  const user = await userModel.findById(userId);
  return { user };
}

async function getAllUsers() {
  const users = await userModel.getAllUsers();
  return { users };
}
async function getAdminUsers() {
  const users = await userModel.getAdminUsers();
  return { users };
}

module.exports = { updateMe, getAllUsers, getAdminUsers };
