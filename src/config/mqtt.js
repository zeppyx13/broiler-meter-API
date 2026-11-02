const mqtt = require("mqtt");
const db = require("./db");
const logger = require("./logger");

let _io = null;

function setIo(io) {
  _io = io;
}

const client = mqtt.connect({
  host: process.env.MQTT_HOST,
  port: process.env.MQTT_PORT,
  username: process.env.MQTT_USERNAME,
  password: process.env.MQTT_PASSWORD,
  protocol: "mqtts",
});

client.on("connect", () => {
  logger.info("MQTT Connected");

  client.subscribe("coasther/meter/+/reading", (err) => {
    if (err) logger.error("Subscribe meter error:", err);
    else logger.info("Subscribed to meter readings");
  });

  client.subscribe("coasther/telemetry/+/live", (err) => {
    if (err) logger.error("Subscribe telemetry error:", err);
    else logger.info("Subscribed to live telemetry");
  });

  client.subscribe("coasther/device/+/log", (err) => {
    if (err) logger.error("Subscribe log error:", err);
    else logger.info("Subscribed to device logs");
  });
});

client.on("message", async (topic, message) => {
  try {
    const payload = JSON.parse(message.toString());
    const parts = topic.split("/");
    const iotService = require("../services/iot.service");

    logger.info("MQTT Topic: " + topic);
    logger.info("Payload: " + JSON.stringify(payload));

    if (
      parts.length === 4 &&
      parts[0] === "coasther" &&
      parts[1] === "meter" &&
      parts[3] === "reading"
    ) {
      const deviceUid = parts[2];

      const [rows] = await db.query(
        `SELECT id, room_id, type, unit, device_uid
         FROM meters
         WHERE device_uid = ?
         LIMIT 1`,
        [deviceUid],
      );

      if (!rows.length) {
        logger.warn("Meter device not registered: " + deviceUid);
        return;
      }

      const meter = rows[0];
      const result = await iotService.ingestMeterReading({ meter, payload });
      logger.info("Meter reading stored: " + JSON.stringify(result));

      if (_io) {
        _io.emit("meter_update", {
          device_uid: deviceUid,
          reading_value: payload.reading_value,
          recorded_at: payload.recorded_at,
          room_id: meter.room_id,
          type: meter.type,
        });
      }

      return;
    }

    if (
      parts.length === 4 &&
      parts[0] === "coasther" &&
      parts[1] === "telemetry" &&
      parts[3] === "live"
    ) {
      const roomTopicId = parts[2];
      const result = await iotService.ingestLiveTelemetry({
        roomTopicId,
        payload,
      });
      logger.info("Live telemetry updated: " + JSON.stringify(result));

      if (_io) {
        _io.emit("telemetry_update", {
          room_id: roomTopicId,
          ...payload,
        });
      }

      return;
    }

    if (
      parts.length === 4 &&
      parts[0] === "coasther" &&
      parts[1] === "device" &&
      parts[3] === "log"
    ) {
      if (_io) {
        _io.emit("iot_log", {
          ...payload,
          room_id: parts[2],
        });
      }
      return;
    }

    logger.warn("Unhandled MQTT topic: " + topic);
  } catch (err) {
    logger.error("MQTT processing error: " + err.message);
    logger.error("MQTT raw topic: " + topic);
    logger.error("MQTT raw payload: " + message.toString());
  }
});

client.on("error", (err) => logger.error("MQTT Error: " + err.message));
client.on("reconnect", () => logger.info("MQTT reconnecting..."));

module.exports = { client, setIo };
