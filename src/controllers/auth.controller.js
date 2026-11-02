const { ok, fail } = require("../utils/response");
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

async function register(req, res) {
  try {
    const payload = registerSchema.parse(req.body);
    const result = await authService.register(payload);
    return ok(res, result, "Register success", 201);
  } catch (err) {
    return fail(res, err.message, err.statusCode || 400);
  }
}

async function login(req, res) {
  try {
    const payload = loginSchema.parse(req.body);
    const result = await authService.login(payload);
    return ok(res, result, "Login success", 200);
  } catch (err) {
    return fail(res, err.message, err.statusCode || 400);
  }
}

async function me(req, res) {
  try {
    const user = await authService.me(req.user.id);
    return ok(res, { user }, "OK", 200);
  } catch (err) {
    return fail(res, err.message, err.statusCode || 400);
  }
}

async function sendResetOtp(req, res) {
  try {
    const payload = sendOtpSchema.parse(req.body);
    const result = await authService.sendResetOtp(payload);
    return ok(res, result, "OK", 200);
  } catch (err) {
    return fail(res, err.message, err.statusCode || 400);
  }
}

async function verifyResetOtp(req, res) {
  try {
    const payload = verifyOtpSchema.parse(req.body);
    const result = await authService.verifyResetOtp(payload);
    return ok(res, result, "OK", 200);
  } catch (err) {
    return fail(res, err.message, err.statusCode || 400);
  }
}

async function resetPasswordWithOtp(req, res) {
  try {
    const payload = resetPasswordWithOtpSchema.parse(req.body);
    const result = await authService.resetPasswordWithOtp(payload);
    return ok(res, result, "OK", 200);
  } catch (err) {
    return fail(res, err.message, err.statusCode || 400);
  }
}

async function sendDeleteOtp(req, res) {
  try {
    sendDeleteOtpSchema.parse(req.body || {});
    const result = await authService.sendDeleteOtp(req.user.id);
    return ok(res, result, "OK", 200);
  } catch (err) {
    return fail(res, err.message, err.statusCode || 400);
  }
}

async function confirmDelete(req, res) {
  try {
    const payload = confirmDeleteSchema.parse(req.body);
    const result = await authService.confirmDeleteAccount(
      req.user.id,
      payload.otp,
    );
    return ok(res, result, "OK", 200);
  } catch (err) {
    return fail(res, err.message, err.statusCode || 400);
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
