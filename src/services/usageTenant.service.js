const tenantModel = require("../models/tenant.model");
const usageTenantModel = require("../models/usageTenant.model");

function httpError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function getCurrentMonthYYYYMM() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

async function getActiveRoomIdOrThrow(userId) {
  const lease = await tenantModel.findActiveLeaseByUserId(userId);
  if (!lease) throw httpError("No active lease", 404);
  return lease.room_id;
}

async function getMyUsageMonthly(userId, month) {
  const room_id = await getActiveRoomIdOrThrow(userId);
  const targetMonth = month || getCurrentMonthYYYYMM();

  const usage = await usageTenantModel.findUsageMonthlyByRoomAndMonth(
    room_id,
    targetMonth,
  );
  if (!usage) {
    return {
      month: targetMonth,
      room_id,
      usage: {
        water_start: 0,
        water_end: 0,
        water_used: 0,
        elec_start: 0,
        elec_end: 0,
        elec_used: 0,
        computed_at: null,
      },
      is_computed: false,
    };
  }

  return { month: targetMonth, room_id, usage, is_computed: true };
}

async function getMyMeterReadings(userId, query) {
  const room_id = await getActiveRoomIdOrThrow(userId);

  const meter = await usageTenantModel.findMeterIdByRoomAndType(
    room_id,
    query.type,
  );
  if (!meter) throw httpError("Meter not found", 404);

  const limit = Math.min(1000, Math.max(1, Number(query.limit || 200)));

  const rows = await usageTenantModel.findMeterReadings({
    meter_id: meter.id,
    from: query.from ? new Date(query.from) : null,
    to: query.to ? new Date(query.to) : null,
    limit,
  });

  return {
    room_id,
    type: meter.type,
    unit: meter.unit,
    readings: rows,
    meta: { limit },
  };
}

module.exports = { getMyUsageMonthly, getMyMeterReadings };
