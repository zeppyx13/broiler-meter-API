const { ok, fail } = require("../utils/response");
const roomService = require("../services/room.service");
const {
  createRoomSchema,
  updateRoomSchema,
  roomIdParamSchema,
  listRoomsQuerySchema,
} = require("../validators/room.validator");

async function getRooms(req, res) {
  try {
    const query = listRoomsQuerySchema.parse(req.query);
    const result = await roomService.listRooms(query);
    return ok(res, result, "OK", 200);
  } catch (err) {
    return fail(res, err.message, err.statusCode || 400);
  }
}

async function getRoomById(req, res) {
  try {
    const { id } = roomIdParamSchema.parse(req.params);
    const result = await roomService.getRoomDetail(id);
    return ok(res, result, "OK", 200);
  } catch (err) {
    return fail(res, err.message, err.statusCode || 400);
  }
}

async function createRoom(req, res) {
  try {
    const payload = createRoomSchema.parse(req.body);
    const result = await roomService.createRoom(payload);
    return ok(res, result, "Room created", 201);
  } catch (err) {
    if (String(err.message || "").includes("Duplicate")) {
      return fail(res, "Room number already exists", 409);
    }
    return fail(res, err.message, err.statusCode || 400);
  }
}

async function updateRoom(req, res) {
  try {
    const { id } = roomIdParamSchema.parse(req.params);
    const payload = updateRoomSchema.parse(req.body);
    const result = await roomService.updateRoom(id, payload);
    return ok(res, result, "Room updated", 200);
  } catch (err) {
    if (String(err.message || "").includes("Duplicate")) {
      return fail(res, "Room number already exists", 409);
    }
    return fail(res, err.message, err.statusCode || 400);
  }
}

async function getlistRoomsWithFacilitiesAndReviewAgg(req, res) {
  try {
    const query = listRoomsQuerySchema.parse(req.query);
    const result = await roomService.listRoomsWithFacilitiesAndReviewAgg(query);
    return ok(res, result, "OK", 200);
  } catch (err) {
    return fail(res, err.message, err.statusCode || 400);
  }
}

async function getDashboardData(req, res) {
  try {
    const result = await roomService.getDashboardData();
    return ok(res, result, "OK", 200);
  } catch (err) {
    return fail(res, err.message, err.statusCode || 400);
  }
}
async function deleteRoom(req, res) {
  try {
    const { id } = roomIdParamSchema.parse(req.params);
    const result = await roomService.deleteRoom(id);
    return ok(res, result, "Room deleted", 200);
  } catch (err) {
    return fail(res, err.message, err.statusCode || 400);
  }
}
module.exports = {
  getRooms,
  getRoomById,
  createRoom,
  updateRoom,
  getDashboardData,
  getlistRoomsWithFacilitiesAndReviewAgg,
  deleteRoom,
};
