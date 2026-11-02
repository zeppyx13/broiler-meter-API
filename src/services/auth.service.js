const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const userModel = require("../models/user.model");
const sendMail = require("../lib/mailer").sendMail;
function sha256(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function signToken(user) {
  return jwt.sign(
    { id: user.id, role: user.role, email: user.email },
    process.env.JWT_SECRET,
    { expiresIn: "7d" },
  );
}
function generateOtp6() {
  return String(Math.floor(100000 + Math.random() * 900000));
}
async function register(payload) {
  const existing = await userModel.findByEmail(payload.email);
  if (existing) {
    const err = new Error("Email already registered");
    err.statusCode = 409;
    throw err;
  }

  const password_hash = await bcrypt.hash(payload.password, 10);

  const userId = await userModel.createUser({
    name: payload.name,
    email: payload.email,
    password_hash,
    phone: payload.phone || null,
    role: "tenant",
  });

  const user = await userModel.findById(userId);
  const token = signToken({ id: user.id, role: user.role, email: user.email });

  return { user, token };
}

async function login(payload) {
  const userRow = await userModel.findByEmail(payload.email);
  if (!userRow) {
    const err = new Error("Invalid email or password");
    err.statusCode = 401;
    throw err;
  }

  const match = await bcrypt.compare(payload.password, userRow.password_hash);
  if (!match) {
    const err = new Error("Invalid email or password");
    err.statusCode = 401;
    throw err;
  }

  const user = await userModel.findById(userRow.id);
  const token = signToken({ id: user.id, role: user.role, email: user.email });

  return { user, token };
}

async function me(userId) {
  const user = await userModel.findById(userId);
  if (!user) {
    const err = new Error("User not found");
    err.statusCode = 404;
    throw err;
  }
  return user;
}

async function sendResetOtp({ email }) {
  const user = await userModel.getOtpMetaByEmail(email);
  const safeResponse = { message: "If the email exists, OTP has been sent." };
  if (!user) return safeResponse;
  if (user.reset_otp_sent_at) {
    const last = new Date(user.reset_otp_sent_at).getTime();
    if (Date.now() - last < 10 * 1000) return safeResponse;
  }

  const otp = generateOtp6();
  const otpHash = sha256(otp);
  const expires = new Date(Date.now() + 2 * 60 * 1000); // 2 menit

  await userModel.setResetOtpByEmail(email, otpHash, expires);

  await sendMail({
    to: user.email,
    subject: "OTP Reset Password Coasther",
    html: `
      <div style="font-family: Arial, sans-serif; line-height: 1.6">
        <h2>OTP Reset Password</h2>
        <p>Halo <b>${user.name}</b>,</p>
        <p>Gunakan OTP berikut untuk reset password:</p>
        <p style="font-size: 28px; letter-spacing: 4px; font-weight: bold;">${otp}</p>
        <p>OTP berlaku selama <b>2 menit</b>. Jangan bagikan kode ini kepada siapa pun.</p>
        <p>Jika Anda tidak meminta reset password, abaikan email ini.</p>
        <br/>
        <p>— Coasther Team</p>
      </div>
    `,
  });

  return safeResponse;
}
async function verifyResetOtp({ email, otp }) {
  const user = await userModel.getOtpMetaByEmail(email);
  if (!user) {
    const err = new Error("Invalid OTP");
    err.statusCode = 400;
    throw err;
  }

  if (!user.reset_otp_hash || !user.reset_otp_expires_at) {
    const err = new Error("OTP not requested");
    err.statusCode = 400;
    throw err;
  }
  if (new Date(user.reset_otp_expires_at).getTime() < Date.now()) {
    const err = new Error("OTP expired");
    err.statusCode = 400;
    throw err;
  }
  if (Number(user.reset_otp_attempts || 0) >= 5) {
    const err = new Error("Too many attempts. Request a new OTP.");
    err.statusCode = 429;
    throw err;
  }

  const otpHash = sha256(otp);

  if (otpHash !== user.reset_otp_hash) {
    await userModel.increaseOtpAttempts(user.id);
    const err = new Error("Invalid OTP");
    err.statusCode = 400;
    throw err;
  }

  return { message: "OTP valid" };
}

async function resetPasswordWithOtp({ email, otp, password }) {
  await verifyResetOtp({ email, otp });

  const user = await userModel.getOtpMetaByEmail(email);
  if (!user) {
    const err = new Error("Invalid request");
    err.statusCode = 400;
    throw err;
  }

  const password_hash = await bcrypt.hash(password, 10);
  await userModel.updatePassword(user.id, password_hash);
  await userModel.clearResetOtp(user.id);

  return { message: "Password reset success" };
}

async function sendDeleteOtp(userId) {
  const user = await userModel.getDeleteOtpMetaByUserId(userId);
  if (!user) {
    const err = new Error("User not found");
    err.statusCode = 404;
    throw err;
  }
  if (user.delete_otp_sent_at) {
    const last = new Date(user.delete_otp_sent_at).getTime();
    if (Date.now() - last < 60 * 1000) {
      return { message: "OTP already sent. Please wait a moment." };
    }
  }
  const otp = generateOtp6();
  const otpHash = sha256(otp);
  const expires = new Date(Date.now() + 10 * 60 * 1000);

  await userModel.setDeleteOtpByUserId(userId, otpHash, expires);

  await sendMail({
    to: user.email,
    subject: "OTP Hapus Akun Coasther",
    html: `
      <div style="font-family: Arial, sans-serif; line-height: 1.6">
        <h2>Konfirmasi Hapus Akun</h2>
        <p>Halo <b>${user.name}</b>,</p>
        <p>Anda meminta untuk menghapus akun Coasther.</p>
        <p>Gunakan OTP berikut untuk konfirmasi:</p>
        <p style="font-size: 28px; letter-spacing: 4px; font-weight: bold;">${otp}</p>
        <p>OTP berlaku selama <b>10 menit</b>.</p>
        <p>Jika Anda tidak merasa melakukan permintaan ini, abaikan email ini.</p>
        <br/>
        <p>— Coasther Team</p>
      </div>
    `,
  });

  return { message: "OTP sent to your email" };
}

async function confirmDeleteAccount(userId, otp) {
  const user = await userModel.getDeleteOtpMetaByUserId(userId);
  if (!user) {
    const err = new Error("User not found");
    err.statusCode = 404;
    throw err;
  }

  if (!user.delete_otp_hash || !user.delete_otp_expires_at) {
    const err = new Error("OTP not requested");
    err.statusCode = 400;
    throw err;
  }

  if (new Date(user.delete_otp_expires_at).getTime() < Date.now()) {
    const err = new Error("OTP expired");
    err.statusCode = 400;
    throw err;
  }

  if (Number(user.delete_otp_attempts || 0) >= 5) {
    const err = new Error("Too many attempts. Request a new OTP.");
    err.statusCode = 429;
    throw err;
  }

  const otpHash = sha256(otp);
  if (otpHash !== user.delete_otp_hash) {
    await userModel.increaseDeleteOtpAttempts(userId);
    const err = new Error("Invalid OTP");
    err.statusCode = 400;
    throw err;
  }

  await userModel.clearDeleteOtp(userId);
  await userModel.hardDeleteUserById(userId);

  return { message: "Account deleted" };
}

module.exports = {
  register,
  login,
  me,
  sendResetOtp,
  verifyResetOtp,
  resetPasswordWithOtp,
  sendDeleteOtp,
  confirmDeleteAccount,
};
