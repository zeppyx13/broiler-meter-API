const express = require("express");
const router = express.Router();

const authController = require("../controllers/auth.controller");
const authMiddleware = require("../middlewares/auth.middleware");

router.post("/register", authController.register);
router.post("/login", authController.login);
router.post("/forgot-password/otp", authController.sendResetOtp);
router.post("/forgot-password/otp/verify", authController.verifyResetOtp);
router.post("/forgot-password/otp/reset", authController.resetPasswordWithOtp);
router.post(
  "/delete-account/otp",
  authMiddleware,
  authController.sendDeleteOtp,
);
router.post(
  "/delete-account/confirm",
  authMiddleware,
  authController.confirmDelete,
);
router.get("/me", authMiddleware, authController.me);
module.exports = router;
