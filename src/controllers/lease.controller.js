const { ok, fail } = require("../utils/response");
const leaseService = require("../services/lease.service");

async function list(req, res) {
  try {
    const result = await leaseService.listLeases(req.query);
    return ok(res, result, "OK", 200);
  } catch (err) {
    return fail(res, err.message, err.statusCode || 500);
  }
}

async function detail(req, res) {
  try {
    const result = await leaseService.getLeaseDetail(Number(req.params.id));
    return ok(res, result, "OK", 200);
  } catch (err) {
    return fail(res, err.message, err.statusCode || 500);
  }
}

async function create(req, res) {
  try {
    const result = await leaseService.createLease(req.body);
    return ok(res, result, "Lease created", 201);
  } catch (err) {
    return fail(res, err.message, err.statusCode || 400);
  }
}

async function update(req, res) {
  try {
    const result = await leaseService.updateLease(
      Number(req.params.id),
      req.body,
    );
    return ok(res, result, "Lease updated", 200);
  } catch (err) {
    return fail(res, err.message, err.statusCode || 400);
  }
}

async function remove(req, res) {
  try {
    const result = await leaseService.deleteLease(Number(req.params.id));
    return ok(res, result, "Lease deleted", 200);
  } catch (err) {
    return fail(res, err.message, err.statusCode || 400);
  }
}

async function tenantBooking(req, res) {
  try {
    const { room_id, start_date, end_date, note } = req.body;
    const user_id = req.user.id;

    const roomModel = require("../models/room.model");
    const room = await roomModel.findById(room_id);
    if (!room) return fail(res, "Room not found", 404);
    if (!room.is_available) return fail(res, "Room not available", 409);

    const result = await leaseService.createLease({
      user_id,
      room_id,
      start_date,
      end_date: end_date || null,
      monthly_rent_snapshot: room.price_monthly,
      note: note || null,
    });

    return ok(res, result, "Booking berhasil", 201);
  } catch (err) {
    return fail(res, err.message, err.statusCode || 400);
  }
}

module.exports = { list, detail, create, update, remove, tenantBooking };
