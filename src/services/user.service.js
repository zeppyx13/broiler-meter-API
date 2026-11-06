const userModel = require("../models/user.model");
const db = require("../config/db");
const withTransaction = require("../utils/transaction");

async function updateMe(userId, payload) {
  if (
    process.env.DB_NAME === "coasther_broiler" &&
    Object.hasOwn(payload, "fcm_token")
  ) {
    throw require("../utils/httpError")(
      400,
      "Mobile push is not supported in Broiler mode",
    );
  }
  return withTransaction(async (connection) => {
    const access = require("./access.service");
    if (payload.default_coop_id != null) {
      await access.lockCoop(connection, payload.default_coop_id);
    }
    const existing = await userModel.findById(userId, connection);
    if (!existing) {
      const err = new Error("User not found");
      err.statusCode = 404;
      throw err;
    }
    if (payload.default_coop_id != null) {
      const coop = await access.requireCoop(
        existing,
        payload.default_coop_id,
        "read",
        connection,
      );
      if (coop.status !== "active" || !coop.farm_is_active) {
        const err = new Error(
          "Default coop must belong to an active farm and be active",
        );
        err.statusCode = 409;
        throw err;
      }
    }
    if (!(await userModel.lockById(userId, connection))) {
      const err = new Error("User not found");
      err.statusCode = 404;
      throw err;
    }
    await userModel.updateById(userId, payload, connection);
    return { user: await userModel.findById(userId, connection) };
  });
}

async function getAllUsers() {
  const users = await userModel.getAllUsers();
  return { users };
}
async function getAdminUsers() {
  const users = await userModel.getAdminUsers();
  return { users };
}

async function deleteAccount(userId) {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const user = await userModel.lockById(userId, connection);
    if (!user) {
      const err = new Error("User not found");
      err.statusCode = 404;
      throw err;
    }
    if (await userModel.hasBusinessReferences(userId, connection)) {
      const err = new Error(
        "Account has farm membership or business history and cannot be deleted",
      );
      err.statusCode = 409;
      throw err;
    }
    await userModel.hardDeleteUserById(userId, connection);
    await connection.commit();
    return { deleted: true };
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}

module.exports = { updateMe, getAllUsers, getAdminUsers, deleteAccount };
