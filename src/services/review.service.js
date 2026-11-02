const reviewModel = require("../models/review.model");
const tenantModel = require("../models/tenant.model");

function httpError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

async function getLeaseForReview(userId) {
  let lease = await tenantModel.findActiveLeaseByUserId(userId);
  if (!lease) {
    throw httpError("No active lease found for review", 404);
  }

  return lease;
}

async function createMyReview(userId, payload) {
  const lease = await getLeaseForReview(userId);

  const existing = await reviewModel.findByUserAndLease({
    user_id: userId,
    lease_id: lease.lease_id,
  });

  if (existing) {
    throw httpError("You already reviewed this room", 409);
  }

  const id = await reviewModel.createReview({
    room_id: lease.room_id,
    user_id: userId,
    lease_id: lease.lease_id,
    rating: payload.rating,
    comment: payload.comment || null,
  });

  return { review_id: id };
}

async function listMyReviews(userId) {
  const rows = await reviewModel.findMyReviews(userId);
  return { reviews: rows };
}

async function listRoomReviews(roomId) {
  const rows = await reviewModel.findReviewsByRoom(roomId);
  return { reviews: rows };
}

async function AllReviews() {
  const rows = await reviewModel.findAllReviews();
  return { reviews: rows };
}
async function roomsRatingSummary() {
  const rows = await reviewModel.getRoomsRatingSummary();
  return { rooms: rows };
}

async function roomRatingSummary(roomId) {
  const row = await reviewModel.getRoomRatingSummary(roomId);
  if (!row) throw httpError("Room not found", 404);
  return { summary: row };
}
module.exports = {
  createMyReview,
  listMyReviews,
  listRoomReviews,
  AllReviews,
  roomsRatingSummary,
  roomRatingSummary,
};
