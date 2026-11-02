const announcementModel = require("../models/announcement.model");
const userModel = require("../models/user.model");
const logger = require("../config/logger");
const { sendNotification } = require("../lib/fcm-sender");

function httpError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

async function listAnnouncements(query) {
  const result = await announcementModel.findAll(query);
  return {
    announcements: result.rows,
    meta: { total: result.total, page: result.page, limit: result.limit },
  };
}

async function getAnnouncementDetail(id) {
  const announcement = await announcementModel.findById(id);
  if (!announcement) throw httpError("Announcement not found", 404);
  return { announcement };
}

async function createAnnouncement(payload) {
  const id = await announcementModel.create(payload);

  // FCM Broadcast
  try {
    const users = await userModel.findAllWithFCMToken();
    for (const user of users) {
      if (user.fcm_token) {
        sendNotification({
          fcm_token: user.fcm_token,
          title: "Pengumuman Baru 📢",
          body: payload.title,
          data: { type: "announcement" }
        }).catch(err => logger.error(`FCM error to ${user.id}:`, err));
      }
    }
  } catch (e) {
    logger.error("Gagal broadcast FCM:", e);
  }

  return getAnnouncementDetail(id);
}

async function updateAnnouncement(id, payload) {
  const existing = await announcementModel.findById(id);
  if (!existing) throw httpError("Announcement not found", 404);
  await announcementModel.updateById(id, payload);
  return getAnnouncementDetail(id);
}

async function deleteAnnouncement(id) {
  const existing = await announcementModel.findById(id);
  if (!existing) throw httpError("Announcement not found", 404);
  await announcementModel.deleteById(id);
  return { deleted: true };
}

module.exports = {
  listAnnouncements,
  getAnnouncementDetail,
  createAnnouncement,
  updateAnnouncement,
  deleteAnnouncement,
};
