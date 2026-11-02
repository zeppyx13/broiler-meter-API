const express = require("express");
const router = express.Router();
const auth = require("../middlewares/auth.middleware");
const { requireRole } = require("../middlewares/role.middleware");
const aiController = require("../controllers/ai.controller");
const adminChatController = require("../controllers/adminChat.controller");
router.get(
  "/rooms/:roomId/insight",
  auth,
  requireRole(["admin", "manager", "tenant"]),
  aiController.getRoomInsight,
);

router.get(
  "/rooms/:roomId/prediction",
  auth,
  requireRole(["admin", "manager", "tenant"]),
  aiController.getRoomPrediction,
);

router.get(
  "/rooms/:roomId/insight/stream",
  auth,
  requireRole(["admin", "manager", "tenant"]),
  aiController.streamRoomInsight,
);

router.get(
  "/rooms/:roomId/prediction/stream",
  auth,
  requireRole(["admin", "manager", "tenant"]),
  aiController.streamRoomPrediction,
);

router.post(
  "/admin-chat",
  auth,
  requireRole(["admin", "manager"]),
  adminChatController.chat,
);

module.exports = router;
