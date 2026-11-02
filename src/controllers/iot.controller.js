const { ok, fail } = require("../utils/response");
const { meterReadingSchema } = require("../validators/iot.validator");
const iotService = require("../services/iot.service");

async function meterReading(req, res) {
  try {
    const payload = meterReadingSchema.parse(req.body);
    const result = await iotService.ingestMeterReading({
      meter: req.meter,
      payload,
    });
    return ok(res, result, "Reading stored", 201);
  } catch (err) {
    return fail(res, err.message, err.statusCode || 400);
  }
}

async function getAllLiveStatus(req, res) {
  try {
    const result = await iotService.getAllLiveStatus();
    return ok(res, result, "Live status fetched");
  } catch (err) {
    return fail(res, err.message, err.statusCode || 500);
  }
}

async function getLiveStatusByRoomId(req, res) {
  try {
    const result = await iotService.getLiveStatusByRoomId(req.params.roomId);
    return ok(res, result, "Live status fetched");
  } catch (err) {
    return fail(res, err.message, err.statusCode || 400);
  }
}

async function relayControl(req, res) {
  try {
    const roomId = Number(req.params.roomId);
    const { command } = req.body;

    if (!roomId || Number.isNaN(roomId)) {
      return fail(res, "Invalid room id", 400);
    }

    const validCommands = [
      "relay_on",
      "relay_off",
      "reset_nvs",
      "sync_ntp",
      "reboot",
      "clear_buf",
      "status",
    ];
    if (!validCommands.includes(command)) {
      return fail(res, `Invalid command. Valid: ${validCommands.join(", ")}`, 400);
    }

    const result = await iotService.sendRelayCommand({ roomId, command });
    return ok(res, result, "Relay command sent", 200);
  } catch (err) {
    return fail(res, err.message, err.statusCode || 500);
  }
}

module.exports = {
  meterReading,
  getAllLiveStatus,
  getLiveStatusByRoomId,
  relayControl,
};
