const db = require("../config/db");

async function findAll() {
  const [rows] = await db.query(
    `SELECT id, name FROM facilities ORDER BY name ASC`,
  );
  return rows;
}

async function findById(id) {
  const [rows] = await db.query(
    `SELECT id, name FROM facilities WHERE id = ? LIMIT 1`,
    [id],
  );
  return rows[0] || null;
}

async function findByName(name) {
  const [rows] = await db.query(
    `SELECT id, name FROM facilities WHERE name = ? LIMIT 1`,
    [name],
  );
  return rows[0] || null;
}

async function create(name) {
  const [result] = await db.query(`INSERT INTO facilities (name) VALUES (?)`, [
    name,
  ]);
  return result.insertId;
}

async function updateById(id, name) {
  await db.query(`UPDATE facilities SET name = ? WHERE id = ?`, [name, id]);
}

async function deleteById(id) {
  await db.query(`DELETE FROM facilities WHERE id = ?`, [id]);
}

async function deleteFromRooms(facility_id) {
  await db.query('DELETE FROM room_facilities WHERE facility_id = ?', [facility_id]);
}

module.exports = {
  findAll,
  findById,
  findByName,
  create,
  updateById,
  deleteById,
  deleteFromRooms,
};
