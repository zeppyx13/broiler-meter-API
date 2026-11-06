async function admin(email, connection) {
  const [rows] = await connection.query(
    "SELECT id, name, role, password_hash FROM users WHERE email = ? FOR UPDATE",
    [email],
  );
  return rows[0] || null;
}

async function createAdmin(email, passwordHash, connection) {
  const [result] = await connection.query(
    "INSERT INTO users (name, email, password_hash, role, is_verified) VALUES (?, ?, ?, 'admin', 1)",
    ["COASTHER Demo Admin", email, passwordHash],
  );
  return result.insertId;
}

async function farm(userId, connection) {
  const [rows] = await connection.query(
    "SELECT * FROM farms WHERE owner_user_id = ? AND name = ? ORDER BY id FOR UPDATE",
    [userId, "COASTHER Demo Farm"],
  );
  return rows[0] || null;
}

module.exports = { admin, createAdmin, farm };
