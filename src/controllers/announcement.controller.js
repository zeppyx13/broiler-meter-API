const { ok, fail } = require("../utils/response");
const announcementService = require("../services/announcement.service");
const {
  createAnnouncementSchema,
  updateAnnouncementSchema,
  announcementIdParamSchema,
  listAnnouncementsQuerySchema,
} = require("../validators/announcement.validator");

async function list(req, res) {
  try {
    const query = listAnnouncementsQuerySchema.parse(req.query);
    const result = await announcementService.listAnnouncements(query);
    return ok(res, result, "OK", 200);
  } catch (err) {
    return fail(res, err.message, err.statusCode || 400);
  }
}

async function detail(req, res) {
  try {
    const { id } = announcementIdParamSchema.parse(req.params);
    const result = await announcementService.getAnnouncementDetail(id);
    return ok(res, result, "OK", 200);
  } catch (err) {
    return fail(res, err.message, err.statusCode || 400);
  }
}

async function create(req, res) {
  try {
    const payload = createAnnouncementSchema.parse(req.body);
    const result = await announcementService.createAnnouncement(payload);
    return ok(res, result, "Announcement created", 201);
  } catch (err) {
    return fail(res, err.message, err.statusCode || 400);
  }
}

async function update(req, res) {
  try {
    const { id } = announcementIdParamSchema.parse(req.params);
    const payload = updateAnnouncementSchema.parse(req.body);
    const result = await announcementService.updateAnnouncement(id, payload);
    return ok(res, result, "Announcement updated", 200);
  } catch (err) {
    return fail(res, err.message, err.statusCode || 400);
  }
}

async function remove(req, res) {
  try {
    const { id } = announcementIdParamSchema.parse(req.params);
    const result = await announcementService.deleteAnnouncement(id);
    return ok(res, result, "Announcement deleted", 200);
  } catch (err) {
    return fail(res, err.message, err.statusCode || 400);
  }
}

module.exports = { list, detail, create, update, remove };
