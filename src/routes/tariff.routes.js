const express = require("express");
const router = express.Router();
const auth = require("../middlewares/auth.middleware");
const { requireRole } = require("../middlewares/role.middleware");
const tariffController = require("../controllers/tariff.controller");

router.get(
  "/",
  auth,
  requireRole(["admin", "manager", "tenant"]),
  tariffController.getTariff,
);

router.put(
  "/",
  auth,
  requireRole(["admin", "manager"]),
  tariffController.updateTariff,
);

module.exports = router;
