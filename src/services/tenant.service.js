const tenantModel = require("../models/tenant.model");

function httpError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

async function getMyRoom(userId) {
  const lease = await tenantModel.findActiveLeaseByUserId(userId);
  if (!lease) throw httpError("No active lease", 404);

  const room = await tenantModel.findRoomById(lease.room_id);
  if (!room) throw httpError("Room not found", 404);

  const facilities = await tenantModel.findFacilitiesByRoomId(room.id);
  const meters = await tenantModel.findMetersByRoomId(room.id);

  return {
    lease,
    room: { ...room, facilities, meters },
  };
}

module.exports = { getMyRoom };
