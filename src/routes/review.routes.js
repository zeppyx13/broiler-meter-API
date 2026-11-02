const express = require("express");
const router = express.Router();

const auth = require("../middlewares/auth.middleware");
const { requireRole } = require("../middlewares/role.middleware");
const reviewController = require("../controllers/review.controller");

router.post(
  "/",
  auth,
  requireRole(["tenant", "admin", "manager"]),
  reviewController.create,
);

router.get(
  "/my",
  auth,
  requireRole(["tenant", "admin", "manager"]),
  reviewController.myReviews,
);

router.get("/rooms/:id", reviewController.roomReviews);
router.get("/", reviewController.allReviews);
router.get("/summary", reviewController.roomsSummary);
router.get("/rooms/:id/summary", reviewController.roomSummary);
module.exports = router;
