const db = require("../config/db");

async function findByEmail(email) {
  const [rows] = await db.query(
    "SELECT id, name, email, password_hash, role, phone, is_verified, default_coop_id, created_at FROM users WHERE email = ? LIMIT 1",
    [email],
  );
  return rows[0] || null;
}

async function findById(id, connection = db) {
  const [rows] = await connection.query(
    "SELECT id, name, email, role, phone, avatar_url, is_verified, default_coop_id, created_at FROM users WHERE id = ? LIMIT 1",
    [id],
  );
  return rows[0] || null;
}

async function findByIds(ids) {
  if (!ids.length) return [];
  const [rows] = await db.query(
    "SELECT id, name, email, fcm_token FROM users WHERE id IN (?)",
    [ids],
  );
  return rows;
}

async function createUser({
  name,
  email,
  password_hash,
  role = "operator",
  phone = null,
}) {
  const [result] = await db.query(
    `INSERT INTO users (name, email, password_hash, role, phone, is_verified)
     VALUES (?, ?, ?, ?, ?, 1)`,
    [name, email, password_hash, role, phone],
  );

  return result.insertId;
}

async function updateById(id, data, connection = db) {
  if (process.env.DB_NAME === "coasther_broiler") {
    await connection.query(
      `UPDATE users SET
         name = CASE WHEN ? THEN ? ELSE name END,
         phone = CASE WHEN ? THEN ? ELSE phone END,
         avatar_url = CASE WHEN ? THEN ? ELSE avatar_url END,
         default_coop_id = CASE WHEN ? THEN ? ELSE default_coop_id END
       WHERE id = ?`,
      [
        data.name !== undefined,
        data.name ?? null,
        data.phone !== undefined,
        data.phone ?? null,
        data.avatar_url !== undefined,
        data.avatar_url ?? null,
        data.default_coop_id !== undefined,
        data.default_coop_id ?? null,
        id,
      ],
    );
    return;
  }
  await connection.query(
    `UPDATE users SET
       name = CASE WHEN ? THEN ? ELSE name END,
       phone = CASE WHEN ? THEN ? ELSE phone END,
       avatar_url = CASE WHEN ? THEN ? ELSE avatar_url END,
       default_coop_id = CASE WHEN ? THEN ? ELSE default_coop_id END,
       fcm_token = CASE WHEN ? THEN ? ELSE fcm_token END
     WHERE id = ?`,
    [
      data.name !== undefined,
      data.name ?? null,
      data.phone !== undefined,
      data.phone ?? null,
      data.avatar_url !== undefined,
      data.avatar_url ?? null,
      data.default_coop_id !== undefined,
      data.default_coop_id ?? null,
      data.fcm_token !== undefined,
      data.fcm_token ?? null,
      id,
    ],
  );
}

async function setResetOtpByEmail(email, reset_otp_hash, reset_otp_expires_at) {
  await db.query(
    `UPDATE users
     SET reset_otp_hash = ?, reset_otp_expires_at = ?, reset_otp_attempts = 0, reset_otp_sent_at = NOW()
     WHERE email = ?`,
    [reset_otp_hash, reset_otp_expires_at, email],
  );
}

async function getOtpMetaByEmail(email) {
  const [rows] = await db.query(
    `SELECT id, name, email, reset_otp_hash, reset_otp_expires_at, reset_otp_attempts, reset_otp_sent_at
     FROM users
     WHERE email = ?
     LIMIT 1`,
    [email],
  );
  return rows[0] || null;
}

async function increaseOtpAttempts(userId) {
  await db.query(
    `UPDATE users
     SET reset_otp_attempts = reset_otp_attempts + 1
     WHERE id = ?`,
    [userId],
  );
}

async function clearResetOtp(userId) {
  await db.query(
    `UPDATE users
     SET reset_otp_hash = NULL,
         reset_otp_expires_at = NULL,
         reset_otp_attempts = 0,
         reset_otp_sent_at = NULL
     WHERE id = ?`,
    [userId],
  );
}

async function updatePassword(userId, password_hash) {
  await db.query(`UPDATE users SET password_hash = ? WHERE id = ?`, [
    password_hash,
    userId,
  ]);
}

async function setDeleteOtpByUserId(userId, otpHash, expires) {
  await db.query(
    `UPDATE users
     SET delete_otp_hash = ?, delete_otp_expires_at = ?, delete_otp_attempts = 0, delete_otp_sent_at = NOW()
     WHERE id = ?`,
    [otpHash, expires, userId],
  );
}

async function getDeleteOtpMetaByUserId(userId) {
  const [rows] = await db.query(
    `SELECT id, name, email, delete_otp_hash, delete_otp_expires_at, delete_otp_attempts, delete_otp_sent_at
     FROM users
     WHERE id = ?
     LIMIT 1`,
    [userId],
  );
  return rows[0] || null;
}

async function increaseDeleteOtpAttempts(userId) {
  await db.query(
    `UPDATE users SET delete_otp_attempts = delete_otp_attempts + 1 WHERE id = ?`,
    [userId],
  );
}

async function clearDeleteOtp(userId) {
  await db.query(
    `UPDATE users
     SET delete_otp_hash = NULL,
         delete_otp_expires_at = NULL,
         delete_otp_attempts = 0,
         delete_otp_sent_at = NULL
     WHERE id = ?`,
    [userId],
  );
}

async function lockById(userId, connection) {
  const [rows] = await connection.query(
    "SELECT id FROM users WHERE id = ? FOR UPDATE",
    [userId],
  );
  return rows[0] || null;
}

async function hasBusinessReferences(userId, connection = db) {
  const [[references]] = await connection.query(
    `SELECT
         EXISTS(SELECT 1 FROM farms WHERE owner_user_id = ?) OR
         EXISTS(SELECT 1 FROM farm_members WHERE user_id = ?) OR
         EXISTS(SELECT 1 FROM flock_events WHERE recorded_by = ?) OR
         EXISTS(SELECT 1 FROM alerts WHERE acknowledged_by = ?) OR
         EXISTS(SELECT 1 FROM notifications WHERE user_id = ?) OR
         EXISTS(SELECT 1 FROM relay_commands WHERE requested_by = ?) OR
         EXISTS(SELECT 1 FROM ai_conversations WHERE user_id = ?) AS has_history`,
    [userId, userId, userId, userId, userId, userId, userId],
  );
  return Boolean(references.has_history);
}

async function hardDeleteUserById(userId, connection = db) {
  await connection.query("DELETE FROM users WHERE id = ?", [userId]);
}

async function getAllUsers() {
  const [rows] = await db.query(
    `SELECT id, name, email, role, phone, created_at FROM users ORDER BY created_at DESC`,
  );
  return rows;
}
async function getAdminUsers() {
  const [rows] = await db.query(
    `SELECT id, name, email, role, phone, created_at FROM users WHERE role = 'admin' or role = 'manager' ORDER BY created_at DESC`,
  );
  return rows;
}
async function findAllWithFCMToken() {
  const [rows] = await db.query(
    "SELECT id, fcm_token FROM users WHERE fcm_token IS NOT NULL AND role = 'operator'",
  );
  return rows;
}
module.exports = {
  findByEmail,
  findById,
  findByIds,
  createUser,
  updateById,
  setResetOtpByEmail,
  getOtpMetaByEmail,
  increaseOtpAttempts,
  clearResetOtp,
  updatePassword,
  setDeleteOtpByUserId,
  getDeleteOtpMetaByUserId,
  increaseDeleteOtpAttempts,
  clearDeleteOtp,
  hardDeleteUserById,
  lockById,
  hasBusinessReferences,
  getAllUsers,
  getAdminUsers,
  findAllWithFCMToken,
};
