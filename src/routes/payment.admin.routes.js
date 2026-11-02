const express = require("express");
const router = express.Router();
const auth = require("../middlewares/auth.middleware");
const { requireRole } = require("../middlewares/role.middleware");
const paymentAdminController = require("../controllers/payment.admin.controller");

router.use(auth);
router.use(requireRole(["admin", "manager"]));

router.get("/", paymentAdminController.list);
router.get("/:id", paymentAdminController.detail);

module.exports = router;
