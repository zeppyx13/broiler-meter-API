const db = require("../config/db");

async function list(user, { farm_id = null, page, limit }, connection = db) {
  const [rows] = await connection.query(
    `SELECT c.*, f.timezone, f.name AS farm_name, f.is_active AS farm_is_active,
            m.role AS member_role
     FROM coops c JOIN farms f ON f.id = c.farm_id
     LEFT JOIN farm_members m ON m.farm_id = f.id AND m.user_id = ?
     WHERE (? = 'admin' OR m.user_id IS NOT NULL) AND (? IS NULL OR c.farm_id = ?)
     ORDER BY c.id LIMIT ? OFFSET ?`,
    [user.id, user.role, farm_id, farm_id, limit, (page - 1) * limit],
  );
  return rows;
}

async function create(data, connection) {
  const [result] = await connection.query(
    `INSERT INTO coops (farm_id, code, name, capacity_birds, description, status)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      data.farm_id,
      data.code,
      data.name,
      data.capacity_birds,
      data.description,
      data.status,
    ],
  );
  return result.insertId;
}

async function update(coopId, data, connection) {
  await connection.query(
    "UPDATE coops SET code = ?, name = ?, capacity_birds = ?, description = ?, status = ? WHERE id = ?",
    [
      data.code,
      data.name,
      data.capacity_birds,
      data.description,
      data.status,
      coopId,
    ],
  );
}

async function activeCycle(coopId, connection) {
  const [rows] = await connection.query(
    "SELECT id, current_population FROM flock_cycles WHERE coop_id = ? AND status = 'active' FOR UPDATE",
    [coopId],
  );
  return rows[0] || null;
}

module.exports = { list, create, update, activeCycle };
