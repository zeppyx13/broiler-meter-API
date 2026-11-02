const { ok, fail } = require("../utils/response");
const reviewService = require("../services/review.service");
const { createReviewSchema } = require("../validators/review.validator");

async function create(req, res) {
  try {
    const payload = createReviewSchema.parse(req.body);
    const result = await reviewService.createMyReview(req.user.id, payload);
    return ok(res, result, "Review submitted", 201);
  } catch (err) {
    return fail(res, err.message, err.statusCode || 400);
  }
}

async function myReviews(req, res) {
  try {
    const result = await reviewService.listMyReviews(req.user.id);
    return ok(res, result, "OK", 200);
  } catch (err) {
    return fail(res, err.message, err.statusCode || 400);
  }
}

async function roomReviews(req, res) {
  try {
    const roomId = Number(req.params.id);
    const result = await reviewService.listRoomReviews(roomId);
    return ok(res, result, "OK", 200);
  } catch (err) {
    return fail(res, err.message, err.statusCode || 400);
  }
}

async function allReviews(req, res) {
  try {
    const result = await reviewService.AllReviews();
    return ok(res, result, "OK", 200);
  } catch (err) {
    return fail(res, err.message, err.statusCode || 400);
  }
}
async function roomsSummary(req, res) {
  try {
    const result = await reviewService.roomsRatingSummary();
    return ok(res, result, "OK", 200);
  } catch (err) {
    return fail(res, err.message, err.statusCode || 400);
  }
}
async function roomSummary(req, res) {
  try {
    const roomId = Number(req.params.id);
    const result = await reviewService.roomRatingSummary(roomId);
    return ok(res, result, "OK", 200);
  } catch (err) {
    return fail(res, err.message, err.statusCode || 400);
  }
}
module.exports = {
  create,
  myReviews,
  roomReviews,
  allReviews,
  roomsSummary,
  roomSummary,
};
