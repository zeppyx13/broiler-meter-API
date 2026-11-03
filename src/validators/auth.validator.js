const { z } = require("zod");
const emailSchema = z.string().trim().email().max(190).toLowerCase();
const passwordSchema = z
  .string()
  .min(6)
  .refine((value) => Buffer.byteLength(value, "utf8") <= 72, {
    message: "Password must not exceed 72 UTF-8 bytes",
  });

const registerSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    email: emailSchema,
    password: passwordSchema,
    phone: z.string().max(30).optional(),
  })
  .strict();

const loginSchema = z
  .object({
    email: emailSchema,
    password: z.string().min(1).max(1024),
  })
  .strict();
const forgotPasswordSchema = z.object({
  email: emailSchema,
});

const resetPasswordSchema = z.object({
  token: z.string().min(20),
  password: passwordSchema,
});
const sendOtpSchema = z.object({
  email: emailSchema,
});

const verifyOtpSchema = z.object({
  email: emailSchema,
  otp: z.string().regex(/^\d{6}$/),
});

const resetPasswordWithOtpSchema = z.object({
  email: emailSchema,
  otp: z.string().regex(/^\d{6}$/),
  password: passwordSchema,
});
const sendDeleteOtpSchema = z.object({});

const confirmDeleteSchema = z.object({
  otp: z.string().regex(/^\d{6}$/),
});
module.exports = {
  registerSchema,
  loginSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  sendOtpSchema,
  verifyOtpSchema,
  resetPasswordWithOtpSchema,
  sendDeleteOtpSchema,
  confirmDeleteSchema,
};
