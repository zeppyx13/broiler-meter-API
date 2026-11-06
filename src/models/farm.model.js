const db = require("../config/db");

async function list(user, { page, limit }, connection = db) {
  const [rows] = await connection.query(
    `SELECT f.*, m.role AS member_role FROM farms f
     LEFT JOIN farm_members m ON m.farm_id = f.id AND m.user_id = ?
     WHERE ? = 'admin' OR m.user_id IS NOT NULL
     ORDER BY f.id LIMIT ? OFFSET ?`,
    [user.id, user.role, limit, (page - 1) * limit],
  );
  return rows;
}

async function create(userId, data, connection) {
  const [result] = await connection.query(
    `INSERT INTO farms (owner_user_id, name, location_text, timezone,
       electricity_rate_idr_per_kwh, water_rate_idr_per_m3) VALUES (?, ?, ?, ?, ?, ?)`,
    [
      userId,
      data.name,
      data.location_text,
      data.timezone,
      data.electricity_rate_idr_per_kwh,
      data.water_rate_idr_per_m3,
    ],
  );
  return result.insertId;
}
async function ownsAnyFarm(userId,connection=db) {
  const [[row]]=await connection.query("SELECT id FROM farms WHERE owner_user_id=? LIMIT 1",[userId]);
  return Boolean(row);
}

async function update(farmId, data, connection) {
  await connection.query(
    `UPDATE farms SET name = ?, location_text = ?, timezone = ?,
       electricity_rate_idr_per_kwh = ?, water_rate_idr_per_m3 = ?, is_active = ? WHERE id = ?`,
    [
      data.name,
      data.location_text,
      data.timezone,
      data.electricity_rate_idr_per_kwh,
      data.water_rate_idr_per_m3,
      data.is_active ? 1 : 0,
      farmId,
    ],
  );
}

async function lockCoops(farmId, connection) {
  await connection.query(
    "SELECT id FROM coops WHERE farm_id = ? ORDER BY id FOR UPDATE",
    [farmId],
  );
}

async function hasActiveCycles(farmId, connection) {
  const [rows] = await connection.query(
    `SELECT fc.id FROM flock_cycles fc JOIN coops c ON c.id = fc.coop_id
     WHERE c.farm_id = ? AND fc.status = 'active' LIMIT 1 FOR UPDATE`,
    [farmId],
  );
  return rows.length > 0;
}

async function members(farmId, { page, limit }, connection = db) {
  const [rows] = await connection.query(
    `SELECT m.id, m.farm_id, m.user_id, m.role, m.created_at, u.name
     FROM farm_members m JOIN users u ON u.id = m.user_id
     WHERE m.farm_id = ? ORDER BY m.id LIMIT ? OFFSET ?`,
    [farmId, limit, (page - 1) * limit],
  );
  return rows;
}

async function findUser(userId, connection) {
  const [rows] = await connection.query("SELECT id FROM users WHERE id = ?", [
    userId,
  ]);
  return rows[0] || null;
}

async function findMember(farmId, userId, connection) {
  const [rows] = await connection.query(
    "SELECT * FROM farm_members WHERE farm_id = ? AND user_id = ? FOR UPDATE",
    [farmId, userId],
  );
  return rows[0] || null;
}

async function addMember(farmId, userId, role, connection) {
  const [result] = await connection.query(
    "INSERT INTO farm_members (farm_id, user_id, role) VALUES (?, ?, ?)",
    [farmId, userId, role],
  );
  return result.insertId;
}

async function updateMember(farmId, userId, role, connection) {
  await connection.query(
    "UPDATE farm_members SET role = ? WHERE farm_id = ? AND user_id = ?",
    [role, farmId, userId],
  );
}

async function removeMember(farmId, userId, connection) {
  await connection.query(
    "DELETE FROM farm_members WHERE farm_id = ? AND user_id = ?",
    [farmId, userId],
  );
}

async function clearMemberDefault(farmId, userId, connection) {
  await connection.query(
    `UPDATE users u JOIN coops c ON c.id = u.default_coop_id
     SET u.default_coop_id = NULL WHERE u.id = ? AND c.farm_id = ? AND u.role <> 'admin'`,
    [userId, farmId],
  );
}

module.exports = {
  list,
  create,
  ownsAnyFarm,
  update,
  lockCoops,
  hasActiveCycles,
  members,
  findUser,
  findMember,
  addMember,
  updateMember,
  removeMember,
  clearMemberDefault,
};
