const leaseModel = require("../models/lease.model");

function httpError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

async function listLeases(query) {
  const result = await leaseModel.findAll({
    status: query.status,
    user_id: query.user_id,
    room_id: query.room_id,
    page: query.page,
    limit: query.limit,
  });

  return {
    leases: result.rows,
    meta: { total: result.total, page: result.page, limit: result.limit },
  };
}

async function getLeaseDetail(id) {
  const lease = await leaseModel.findById(id);
  if (!lease) throw httpError("Lease not found", 404);
  return { lease };
}

async function createLease(payload) {
  // Cek kamar sudah ada lease aktif
  const activeRoom = await leaseModel.findActiveByRoomId(payload.room_id);
  if (activeRoom) throw httpError("Room already has an active lease", 409);

  // Cek tenant sudah ada lease aktif
  const activeUser = await leaseModel.findActiveByUserId(payload.user_id);
  if (activeUser) throw httpError("Tenant already has an active lease", 409);

  const id = await leaseModel.create(payload);

  // Set kamar jadi tidak tersedia
  await leaseModel.setRoomAvailability(payload.room_id, false);

  return getLeaseDetail(id);
}

async function updateLease(id, payload) {
  const existing = await leaseModel.findById(id);
  if (!existing) throw httpError("Lease not found", 404);

  await leaseModel.updateById(id, payload);

  // Kalau status diubah jadi ended, set kamar jadi tersedia kembali
  if (payload.status === "ended") {
    await leaseModel.setRoomAvailability(existing.room_id, true);
  }

  return getLeaseDetail(id);
}

async function deleteLease(id) {
  const existing = await leaseModel.findById(id);
  if (!existing) throw httpError("Lease not found", 404);

  // Kembalikan kamar jadi tersedia
  if (existing.status === "active") {
    await leaseModel.setRoomAvailability(existing.room_id, true);
  }

  await leaseModel.deleteById(id);
  return { deleted: true };
}

module.exports = {
  listLeases,
  getLeaseDetail,
  createLease,
  updateLease,
  deleteLease,
};
