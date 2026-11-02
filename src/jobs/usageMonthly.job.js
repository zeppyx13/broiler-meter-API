const usageModel = require("../models/usageMonthly.model");

function httpError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function assertYYYYMM(month) {
  if (!/^\d{4}-\d{2}$/.test(month)) {
    throw httpError("month must be in YYYY-MM format", 400);
  }
  const [y, m] = month.split("-").map(Number);
  if (m < 1 || m > 12) throw httpError("Invalid month", 400);
  return { y, m };
}

function getMonthRangeUTC(month) {
  const { y, m } = assertYYYYMM(month);
  const startAt = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0));
  const endAt = new Date(Date.UTC(y, m, 1, 0, 0, 0));
  return { startAt, endAt };
}

function toNumber3(x) {
  const n = Number(x || 0);
  return Math.round(n * 1000) / 1000;
}

async function findAllReadingsInRange(meter_id, startAt, endAt) {
  return usageModel.findAllReadingsInRange(meter_id, startAt, endAt);
}

const RESET_THRESHOLD = 0.5;

async function computeStartEndForMeter(meter_id, startAt, endAt) {
  const beforeStart = await usageModel.findLastReadingBefore(meter_id, startAt);
  const readingsInRange = await findAllReadingsInRange(
    meter_id,
    startAt,
    endAt,
  );
  if (!readingsInRange.length && !beforeStart) {
    return { startVal: 0, endVal: 0, usedVal: 0, resetDetected: false };
  }
  const allReadings = [];
  if (beforeStart) {
    allReadings.push(beforeStart);
  } else if (readingsInRange.length > 0) {
    allReadings.push(readingsInRange[0]);
  }
  allReadings.push(...readingsInRange);

  if (allReadings.length < 2) {
    const singleVal = toNumber3(allReadings[0]?.reading_value ?? 0);
    return {
      startVal: singleVal,
      endVal: singleVal,
      usedVal: 0,
      resetDetected: false,
    };
  }
  let totalUsed = 0;
  let resetDetected = false;
  let segmentStart = toNumber3(allReadings[0].reading_value);

  for (let i = 1; i < allReadings.length; i++) {
    const prev = toNumber3(allReadings[i - 1].reading_value);
    const curr = toNumber3(allReadings[i].reading_value);

    const isReset =
      curr < prev && prev > 0 && curr / prev < 1 - RESET_THRESHOLD;

    if (isReset) {
      const segmentUsed = toNumber3(Math.max(0, prev - segmentStart));
      totalUsed = toNumber3(totalUsed + segmentUsed);
      resetDetected = true;

      segmentStart = curr;
    }
  }

  const lastVal = toNumber3(allReadings[allReadings.length - 1].reading_value);
  const lastSegmentUsed = toNumber3(Math.max(0, lastVal - segmentStart));
  totalUsed = toNumber3(totalUsed + lastSegmentUsed);
  const startVal = toNumber3(allReadings[0].reading_value);
  const endReading =
    readingsInRange.length > 0
      ? readingsInRange[readingsInRange.length - 1]
      : allReadings[allReadings.length - 1];
  const endVal = toNumber3(endReading.reading_value);

  return {
    startVal,
    endVal,
    usedVal: toNumber3(totalUsed),
    resetDetected,
  };
}

async function runUsageMonthly(month) {
  const { startAt, endAt } = getMonthRangeUTC(month);
  const roomIds = await usageModel.findAllRoomIds();

  let processed = 0;
  const resets = [];

  for (const roomId of roomIds) {
    const waterMeter = await usageModel.findMeterByRoomAndType(roomId, "water");
    const elecMeter = await usageModel.findMeterByRoomAndType(
      roomId,
      "electricity",
    );

    let water = { startVal: 0, endVal: 0, usedVal: 0, resetDetected: false };
    let elec = { startVal: 0, endVal: 0, usedVal: 0, resetDetected: false };

    if (waterMeter) {
      water = await computeStartEndForMeter(waterMeter.id, startAt, endAt);
    }
    if (elecMeter) {
      elec = await computeStartEndForMeter(elecMeter.id, startAt, endAt);
    }

    if (water.resetDetected || elec.resetDetected) {
      resets.push({
        room_id: roomId,
        water_reset: water.resetDetected,
        elec_reset: elec.resetDetected,
      });
    }

    await usageModel.upsertUsageMonthly({
      room_id: roomId,
      month,
      water_start: water.startVal,
      water_end: water.endVal,
      water_used: water.usedVal,
      elec_start: elec.startVal,
      elec_end: elec.endVal,
      elec_used: elec.usedVal,
      computed_at: new Date(),
    });

    processed += 1;
  }

  return {
    month,
    start_at: startAt.toISOString(),
    end_at: endAt.toISOString(),
    rooms_processed: processed,
    resets_detected: resets,
  };
}

module.exports = { runUsageMonthly };
