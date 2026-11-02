const express = require("express");
const router = express.Router();
const auth = require("../middlewares/auth.middleware");
const { requireRole } = require("../middlewares/role.middleware");
const facilityController = require("../controllers/facility.controller");

// Public
router.get("/", facilityController.list);
router.get("/:id", facilityController.detail);

// Admin only
router.post(
  "/",
  auth,
  requireRole(["admin", "manager"]),
  facilityController.create,
);
router.patch(
  "/:id",
  auth,
  requireRole(["admin", "manager"]),
  facilityController.update,
);
router.delete(
  "/:id",
  auth,
  requireRole(["admin", "manager"]),
  facilityController.remove,
);

module.exports = router;
