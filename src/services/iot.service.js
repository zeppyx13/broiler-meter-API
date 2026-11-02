const iotModel = require("../models/iot.model");
const { client: mqttClient } = require("../config/mqtt");
const logger = require("../config/logger");
function httpError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

async function ingestMeterReading({ meter, payload }) {
  const readingValue = Number(payload.reading_value);

  if (Number.isNaN(readingValue) || readingValue < 0) {
    throw httpError("Invalid reading_value", 400);
  }

  let recordedAt = new Date();
  if (payload.recorded_at) {
    const parsed = new Date(payload.recorded_at);
    if (!Number.isNaN(parsed.getTime())) {
      recordedAt = parsed;
    }
  }

  const last = await iotModel.findLastReading(meter.id);

  const isHistorical = last && recordedAt < new Date(last.recorded_at);

  if (!isHistorical && last && readingValue < Number(last.reading_value)) {
    throw httpError("Reading value cannot be less than last reading", 400);
  }

  const readingId = await iotModel.insertReading({
    meter_id: meter.id,
    reading_value: readingValue,
    recorded_at: recordedAt,
  });

  return {
    reading_id: readingId,
    meter_id: meter.id,
    room_id: meter.room_id,
    type: meter.type,
    unit: meter.unit,
    reading_value: readingValue,
    recorded_at: recordedAt,
  };
}

async function ingestLiveTelemetry({ roomTopicId, payload }) {
  const roomId = Number(payload.room_id);

  if (Number.isNaN(roomId) || roomId <= 0) {
    throw httpError("Invalid room_id", 400);
  }

  const flowRate = Number(payload.flow_rate_lpm ?? 0);
  const waterTotalLiter = Number(payload.water_total_liter ?? 0);
  const voltage = Number(payload.voltage ?? 0);
  const current = Number(payload.current ?? 0);
  const power = Number(payload.power ?? 0);
  const energyKwhTotal = Number(payload.energy_kwh_total ?? 0);
  const frequency = Number(payload.frequency ?? 0);
  const pf = Number(payload.pf ?? 0);

  const values = [
    flowRate,
    waterTotalLiter,
    voltage,
    current,
    power,
    energyKwhTotal,
    frequency,
    pf,
  ];

  if (values.some((v) => Number.isNaN(v) || v < 0)) {
    throw httpError("Invalid telemetry payload", 400);
  }

  let recordedAt = new Date();
  if (payload.recorded_at) {
    const parsed = new Date(payload.recorded_at);
    if (!Number.isNaN(parsed.getTime())) {
      recordedAt = parsed;
    }
  }

  await iotModel.upsertLiveStatus({
    room_id: roomId,
    flow_rate_lpm: flowRate,
    water_total_liter: waterTotalLiter,
    voltage,
    current,
    power,
    energy_kwh_total: energyKwhTotal,
    frequency,
    pf,
    recorded_at: recordedAt,
  });

  return {
    room_topic_id: roomTopicId,
    room_id: roomId,
    flow_rate_lpm: flowRate,
    water_total_liter: waterTotalLiter,
    voltage,
    current,
    power,
    energy_kwh_total: energyKwhTotal,
    frequency,
    pf,
    recorded_at: recordedAt,
  };
}

async function getAllLiveStatus() {
  return await iotModel.findAllLiveStatus();
}

async function getLiveStatusByRoomId(roomId) {
  const numericRoomId = Number(roomId);

  if (Number.isNaN(numericRoomId) || numericRoomId <= 0) {
    throw httpError("Invalid room id", 400);
  }

  return await iotModel.findLiveStatusByRoomId(numericRoomId);
}

async function sendRelayCommand({ roomId, command }) {
  const device = await iotModel.findActiveDeviceByRoomId(roomId);

  if (!device) {
    const err = new Error("Room or meter not found");
    err.statusCode = 404;
    throw err;
  }

  const roomTopicId = device.device_uid
    .replace("esp32_", "")
    .replace("_water", "")
    .replace("_electric", "");

  const topic = `coasther/device/${roomTopicId}/control`;
  const secureCommand = `${command}:${process.env.MQTT_CMD_TOKEN}`;

  return new Promise((resolve, reject) => {
    mqttClient.publish(topic, secureCommand, { qos: 1 }, (err) => {
      if (err) {
        const e = new Error("Failed to publish MQTT command");
        e.statusCode = 502;
        return reject(e);
      }

      logger.info(`[RELAY] Published to ${topic}: ${secureCommand}`);
      resolve({
        room_id: roomId,
        room_topic_id: roomTopicId,
        topic,
        command,
        secure_command: secureCommand,
        sent_at: new Date().toISOString(),
      });
    });
  });
}

module.exports = {
  ingestMeterReading,
  ingestLiveTelemetry,
  getAllLiveStatus,
  getLiveStatusByRoomId,
  sendRelayCommand,
};
