const express = require("express");
const router = express.Router();
const auth = require("../middlewares/auth.middleware");
const { requireRole } = require("../middlewares/role.middleware");
const schedulerController = require("../controllers/scheduler.controller");

router.use(auth);
router.use(requireRole(["admin", "manager"]));

router.get("/status", schedulerController.getJobStatus);
router.post("/overdue", schedulerController.triggerOverdue);
router.post("/billing", schedulerController.triggerBilling);
router.post("/cleanup", schedulerController.triggerCleanup);

module.exports = router;
