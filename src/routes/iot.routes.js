const express = require("express");
const router = express.Router();

const auth = require("../middlewares/auth.middleware");
const { requireRole } = require("../middlewares/role.middleware");
const iotAuth = require("../middlewares/iotAuth.middleware");
const iotController = require("../controllers/iot.controller");

router.post("/meter-reading", iotAuth, iotController.meterReading);

router.get(
  "/live-status",
  auth,
  requireRole(["admin", "manager"]),
  iotController.getAllLiveStatus,
);
router.get(
  "/live-status/:roomId",
  auth,
  requireRole(["admin", "manager", "tenant"]),
  iotController.getLiveStatusByRoomId,
);

router.post(
  "/relay/:roomId",
  auth,
  requireRole(["admin", "manager"]),
  iotController.relayControl,
);

module.exports = router;
