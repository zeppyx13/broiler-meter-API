const db = require("../config/db");

async function farmForUser(userId, farmId, connection = db) {
  const [rows] = await connection.query(
    `SELECT f.*, m.role AS member_role
     FROM farms f LEFT JOIN farm_members m ON m.farm_id = f.id AND m.user_id = ?
     WHERE f.id = ? LOCK IN SHARE MODE`,
    [userId, farmId],
  );
  return rows[0] || null;
}

async function coopForUser(userId, coopId, connection = db) {
  const [rows] = await connection.query(
    `SELECT c.*, f.timezone, f.name AS farm_name, f.is_active AS farm_is_active,
            f.owner_user_id, m.role AS member_role
     FROM coops c JOIN farms f ON f.id = c.farm_id
     LEFT JOIN farm_members m ON m.farm_id = f.id AND m.user_id = ?
     WHERE c.id = ? LOCK IN SHARE MODE`,
    [userId, coopId],
  );
  return rows[0] || null;
}

async function lockFarm(farmId, connection) {
  const [rows] = await connection.query("SELECT * FROM farms WHERE id = ? FOR UPDATE", [farmId]);
  return rows[0] || null;
}

async function lockCoop(coopId, connection) {
  const [rows] = await connection.query("SELECT * FROM coops WHERE id = ? FOR UPDATE", [coopId]);
  return rows[0] || null;
}

async function findCoop(coopId, connection = db) {
  const [rows] = await connection.query("SELECT * FROM coops WHERE id = ?", [coopId]);
  return rows[0] || null;
}

async function lockUser(userId, connection) {
  const [rows] = await connection.query("SELECT id, default_coop_id FROM users WHERE id = ? FOR UPDATE", [userId]);
  return rows[0] || null;
}

async function findDefaultCoop(user, connection = db) {
  const [rows] = await connection.query(
    `SELECT c.*, f.timezone, f.name AS farm_name, f.is_active AS farm_is_active,
            f.owner_user_id, m.role AS member_role
     FROM users u JOIN coops c ON c.id = u.default_coop_id
     JOIN farms f ON f.id = c.farm_id
     LEFT JOIN farm_members m ON m.farm_id = f.id AND m.user_id = u.id
     WHERE u.id = ? AND c.status = 'active' AND f.is_active = 1
       AND (? = 'admin' OR m.user_id IS NOT NULL)`,
    [user.id, user.role],
  );
  return rows[0] || null;
}

async function firstAccessibleCoop(user, connection = db) {
  const [rows] = await connection.query(
    `SELECT c.*, f.timezone, f.name AS farm_name, f.is_active AS farm_is_active,
            f.owner_user_id, m.role AS member_role
     FROM coops c JOIN farms f ON f.id = c.farm_id
     LEFT JOIN farm_members m ON m.farm_id = f.id AND m.user_id = ?
     WHERE c.status = 'active' AND f.is_active = 1
       AND (? = 'admin' OR m.user_id IS NOT NULL)
     ORDER BY c.id LIMIT 1`,
    [user.id, user.role],
  );
  return rows[0] || null;
}

async function setDefaultCoop(userId, coopId, connection = db) {
  await connection.query("UPDATE users SET default_coop_id = ? WHERE id = ?", [coopId, userId]);
}

module.exports = {
  farmForUser, coopForUser, lockFarm, lockCoop, findCoop, lockUser,
  findDefaultCoop, firstAccessibleCoop, setDefaultCoop,
};
