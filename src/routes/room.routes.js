const express = require("express");
const router = express.Router();

const roomController = require("../controllers/room.controller");
const auth = require("../middlewares/auth.middleware");
const { requireRole } = require("../middlewares/role.middleware");

router.get("/", roomController.getRooms);
router.get("/all", roomController.getlistRoomsWithFacilitiesAndReviewAgg);
router.get("/:id", roomController.getRoomById);

router.post(
  "/",
  auth,
  requireRole(["admin", "manager"]),
  roomController.createRoom,
);
router.patch(
  "/:id",
  auth,
  requireRole(["admin", "manager"]),
  roomController.updateRoom,
);
router.get(
  "/dashboard/data",
  auth,
  requireRole(["admin", "manager"]),
  roomController.getDashboardData,
);
router.delete(
  "/:id",
  auth,
  requireRole(["admin", "manager"]),
  roomController.deleteRoom,
);
module.exports = router;
