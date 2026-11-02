const { ok } = require("../utils/response");
const authService = require("../services/auth.service");
const {
  registerSchema,
  loginSchema,
  sendOtpSchema,
  verifyOtpSchema,
  resetPasswordWithOtpSchema,
  sendDeleteOtpSchema,
  confirmDeleteSchema,
} = require("../validators/auth.validator");

async function register(req, res, next) {
  try {
    const payload = registerSchema.parse(req.body);
    const result = await authService.register(payload);
    return ok(res, result, "Register success", 201);
  } catch (err) {
    return next(err);
  }
}

async function login(req, res, next) {
  try {
    const payload = loginSchema.parse(req.body);
    const result = await authService.login(payload);
    return ok(res, result, "Login success", 200);
  } catch (err) {
    return next(err);
  }
}

async function me(req, res, next) {
  try {
    const user = await authService.me(req.user.id);
    return ok(res, { user }, "OK", 200);
  } catch (err) {
    return next(err);
  }
}

async function sendResetOtp(req, res, next) {
  try {
    const payload = sendOtpSchema.parse(req.body);
    const result = await authService.sendResetOtp(payload);
    return ok(res, result, "OK", 200);
  } catch (err) {
    return next(err);
  }
}

async function verifyResetOtp(req, res, next) {
  try {
    const payload = verifyOtpSchema.parse(req.body);
    const result = await authService.verifyResetOtp(payload);
    return ok(res, result, "OK", 200);
  } catch (err) {
    return next(err);
  }
}

async function resetPasswordWithOtp(req, res, next) {
  try {
    const payload = resetPasswordWithOtpSchema.parse(req.body);
    const result = await authService.resetPasswordWithOtp(payload);
    return ok(res, result, "OK", 200);
  } catch (err) {
    return next(err);
  }
}

async function sendDeleteOtp(req, res, next) {
  try {
    sendDeleteOtpSchema.parse(req.body || {});
    const result = await authService.sendDeleteOtp(req.user.id);
    return ok(res, result, "OK", 200);
  } catch (err) {
    return next(err);
  }
}

async function confirmDelete(req, res, next) {
  try {
    const payload = confirmDeleteSchema.parse(req.body);
    const result = await authService.confirmDeleteAccount(
      req.user.id,
      payload.otp,
    );
    return ok(res, result, "OK", 200);
  } catch (err) {
    return next(err);
  }
}
module.exports = {
  register,
  login,
  me,
  sendResetOtp,
  verifyResetOtp,
  resetPasswordWithOtp,
  sendDeleteOtp,
  confirmDelete,
};
