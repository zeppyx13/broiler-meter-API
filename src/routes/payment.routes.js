const express = require("express");
const router = express.Router();

const auth = require("../middlewares/auth.middleware");
const { requireRole } = require("../middlewares/role.middleware");
const paymentController = require("../controllers/payment.controller");

router.post(
  "/midtrans",
  auth,
  requireRole(["tenant", "admin", "manager"]),
  paymentController.createMidtrans,
);

router.post("/midtrans/webhook", paymentController.midtransWebhook);

module.exports = router;
