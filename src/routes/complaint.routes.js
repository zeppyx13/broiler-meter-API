const express = require("express");
const router = express.Router();
const auth = require("../middlewares/auth.middleware");
const { requireRole } = require("../middlewares/role.middleware");
const complaintController = require("../controllers/complaint.controller");

router.use(auth);
router.use(requireRole(["tenant", "admin", "manager"]));

router.get(
  "/admin/complaints",
  requireRole(["admin", "manager"]),
  complaintController.listAll,
);
router.get(
  "/admin/complaints/:id",
  requireRole(["admin", "manager"]),
  complaintController.adminDetail,
);
router.patch(
  "/admin/complaints/:id",
  requireRole(["admin", "manager"]),
  complaintController.adminUpdate,
);

router.get("/", complaintController.list);
router.post("/", complaintController.create);
router.get("/:id", complaintController.detail);
router.patch("/:id", complaintController.update);

module.exports = router;
