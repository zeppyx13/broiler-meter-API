const rateLimit = require("express-rate-limit");
const dotenv = require("dotenv");
dotenv.config();

// General API — semua endpoint
const generalLimiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_GENERAL_WINDOW_MS),
  max: Number(process.env.RATE_LIMIT_GENERAL_MAX),
  message: {
    success: false,
    message: "Terlalu banyak request, coba lagi nanti.",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Auth — login, register, OTP (lebih ketat)
const authLimiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_AUTH_WINDOW_MS),
  max: Number(process.env.RATE_LIMIT_AUTH_MAX),
  message: {
    success: false,
    message: "Terlalu banyak percobaan login, coba lagi dalam 15 menit.",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// AI — Gemini calls (sangat ketat, hemat token)
const aiLimiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_AI_WINDOW_MS),
  max: Number(process.env.RATE_LIMIT_AI_MAX),
  message: {
    success: false,
    message: "Limit AI request tercapai, coba lagi dalam 1 jam.",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Scheduler manual trigger (sangat ketat)
const schedulerLimiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_SCHEDULER_WINDOW_MS),
  max: Number(process.env.RATE_LIMIT_SCHEDULER_MAX),
  message: { success: false, message: "Limit scheduler trigger tercapai." },
  standardHeaders: true,
  legacyHeaders: false,
});

// Relay control
const relayLimiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_RELAY_WINDOW_MS),
  max: Number(process.env.RATE_LIMIT_RELAY_MAX),
  message: {
    success: false,
    message: "Terlalu banyak relay command, tunggu sebentar.",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Upload
const uploadLimiter = rateLimit({
    windowMs: 60 * 1000,      // 1 menit
    max: 10,                   // max 10 upload per menit per IP
    message: {
        success: false,
        message: "Too many upload requests, please try again later",
    },
    standardHeaders: true,
    legacyHeaders: false,
});

module.exports = {
  generalLimiter,
  authLimiter,
  aiLimiter,
  schedulerLimiter,
  relayLimiter,
  uploadLimiter,
};
