const complaintModel = require("../models/complaint.model");
const tenantModel = require("../models/tenant.model");
const userModel = require("../models/user.model");
const logger = require("../config/logger");
const { sendNotification } = require("../lib/fcm-sender");

function httpError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

async function getActiveRoomIdOrThrow(userId) {
  const lease = await tenantModel.findActiveLeaseByUserId(userId);
  if (!lease) throw httpError("No active lease", 404);
  return lease.room_id;
}

async function createMyComplaint(userId, payload) {
  const room_id = await getActiveRoomIdOrThrow(userId);

  const id = await complaintModel.createComplaint({
    user_id: userId,
    room_id,
    title: payload.title,
    description: payload.description,
  });

  const created = await complaintModel.findByIdForUser({ id, user_id: userId });
  return { complaint: created };
}

async function listMyComplaints(userId, query) {
  const result = await complaintModel.findAllForUser({
    user_id: userId,
    status: query.status,
    page: query.page,
    limit: query.limit,
  });

  return {
    complaints: result.rows,
    meta: { total: result.total, page: result.page, limit: result.limit },
  };
}

async function getMyComplaintDetail(userId, id) {
  const complaint = await complaintModel.findByIdForUser({
    id,
    user_id: userId,
  });
  if (!complaint) throw httpError("Complaint not found", 404);
  return { complaint };
}

async function updateMyComplaint(userId, id, payload) {
  const existing = await complaintModel.findByIdForUser({
    id,
    user_id: userId,
  });
  if (!existing) throw httpError("Complaint not found", 404);
  const data = {};

  if (payload.status === "closed") {
    data.status = "closed";
    data.closed_at = new Date();
  } else {
    if (existing.status !== "open") {
      throw httpError("Cannot edit complaint unless status is 'open'", 400);
    }
    if (payload.title !== undefined) data.title = payload.title;
    if (payload.description !== undefined)
      data.description = payload.description;
  }

  await complaintModel.updateComplaintForUser({ id, user_id: userId, data });

  const updated = await complaintModel.findByIdForUser({ id, user_id: userId });
  return { complaint: updated };
}

async function listAllComplaints(query) {
  const result = await complaintModel.findAll({
    status: query.status,
    page: query.page,
    limit: query.limit,
  });

  return {
    complaints: result.rows,
    meta: {
      total: result.total,
      page: result.page,
      limit: result.limit,
    },
  };
}
async function getComplaintDetailAdmin(id) {
  const complaint = await complaintModel.findByIdAdmin(id);
  if (!complaint) throw httpError("Complaint not found", 404);
  return { complaint };
}

async function updateComplaintAdmin(id, payload) {
  const existing = await complaintModel.findByIdAdmin(id);
  if (!existing) throw httpError("Complaint not found", 404);

  await complaintModel.updateComplaintAdmin(id, payload);

  // FCM Notification
  try {
    const user = await userModel.findById(existing.user_id);
    if (user?.fcm_token && payload.status) {
      sendNotification({
        fcm_token: user.fcm_token,
        title: "Update Keluhan 🔔",
        body: `Status keluhan "${existing.title}" kamu diperbarui menjadi ${payload.status}.`,
        data: { type: "complaint" }
      }).catch(err => logger.error(`[FCM] Error: ${err.message}`));
    }
  } catch (e) {
    logger.error(`[FCM] Gagal kirim: ${e.message}`);
  }

  return getComplaintDetailAdmin(id);
}
module.exports = {
  createMyComplaint,
  listMyComplaints,
  getMyComplaintDetail,
  updateMyComplaint,
  listAllComplaints,
  getComplaintDetailAdmin,
  updateComplaintAdmin,
};
