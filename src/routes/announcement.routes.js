const express = require("express");
const router = express.Router();
const auth = require("../middlewares/auth.middleware");
const { requireRole } = require("../middlewares/role.middleware");
const announcementController = require("../controllers/announcement.controller");

// Public — tenant bisa baca
router.get("/", announcementController.list);
router.get("/:id", announcementController.detail);

// Admin only
router.post(
  "/",
  auth,
  requireRole(["admin", "manager"]),
  announcementController.create,
);
router.patch(
  "/:id",
  auth,
  requireRole(["admin", "manager"]),
  announcementController.update,
);
router.delete(
  "/:id",
  auth,
  requireRole(["admin", "manager"]),
  announcementController.remove,
);

module.exports = router;
