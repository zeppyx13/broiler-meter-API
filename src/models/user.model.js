const db = require("../config/db");

async function findByEmail(email) {
  const [rows] = await db.query(
    "SELECT id, name, email, password_hash, role, phone, is_verified, created_at FROM users WHERE email = ? LIMIT 1",
    [email],
  );
  return rows[0] || null;
}

async function findById(id) {
  const [rows] = await db.query(
    "SELECT id, name, email, role, phone, avatar_url, is_verified, created_at FROM users WHERE id = ? LIMIT 1",
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
  role = "tenant",
  phone = null,
}) {
  const [result] = await db.query(
    `INSERT INTO users (name, email, password_hash, role, phone, is_verified)
     VALUES (?, ?, ?, ?, ?, 1)`,
    [name, email, password_hash, role, phone],
  );

  return result.insertId;
}

async function updateById(id, data) {
  const allowed = ["name", "phone"];
  const fields = [];
  const params = [];

  for (const key of allowed) {
    if (data[key] === undefined) continue;
    fields.push(`${key} = ?`);
    params.push(data[key]);
  }

  if (!fields.length) return;

  params.push(id);
  await db.query(`UPDATE users SET ${fields.join(", ")} WHERE id = ?`, params);
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

async function hardDeleteUserById(userId) {
  await db.query(
    `DELETE FROM payments WHERE invoice_id IN (SELECT id FROM invoices WHERE user_id = ?)`,
    [userId],
  );
  await db.query(`DELETE FROM invoices WHERE user_id = ?`, [userId]);
  await db.query(`DELETE FROM reviews WHERE user_id = ?`, [userId]);
  await db.query(`DELETE FROM complaints WHERE user_id = ?`, [userId]);
  await db.query(`DELETE FROM leases WHERE user_id = ?`, [userId]);
  await db.query(`DELETE FROM users WHERE id = ?`, [userId]);
}

async function getAllUsers() {
  const [rows] = await db.query(
    `SELECT id, name, email, role, phone, created_at FROM users WHERE role = 'tenant' AND role != 'manager' ORDER BY created_at DESC`,
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
    "SELECT id, fcm_token FROM users WHERE fcm_token IS NOT NULL AND role = 'tenant'",
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
  getAllUsers,
  getAdminUsers,
  findAllWithFCMToken,
};
