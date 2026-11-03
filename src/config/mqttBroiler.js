const mqtt = require("mqtt");
const logger = require("./logger");
const service = require("../services/iotBroiler.service");

const topics = [
  "coasther/meter/+/reading",
  "coasther/telemetry/+/live",
  "coasther/device/+/log",
  "coasther/device/+/control-status",
];

function start({ io, connect = mqtt.connect } = {}) {
  if (process.env.BROILER_MQTT_ENABLED === "false") {
    logger.info("Broiler MQTT disabled by environment");
    return { client: null, async stop() {} };
  }
  if (
    !process.env.MQTT_HOST ||
    !process.env.MQTT_USERNAME ||
    !process.env.MQTT_PASSWORD
  ) {
    logger.warn("Broiler MQTT not started: MQTT environment is incomplete");
    return { client: null, async stop() {} };
  }
  const client = connect({
    host: process.env.MQTT_HOST,
    port: Number(process.env.MQTT_PORT || 8883),
    username: process.env.MQTT_USERNAME,
    password: process.env.MQTT_PASSWORD,
    protocol: "mqtts",
    rejectUnauthorized: true,
    reconnectPeriod: 5000,
    connectTimeout: 15000,
    resubscribe: false,
  });
  client.on("connect", () => {
    logger.info("Broiler MQTT connected");
    client.subscribe(topics, { qos: 1 }, (error, grants) => {
      if (error || grants?.some((grant) => grant.qos === 128))
        logger.warn("Broiler MQTT subscription failed");
      else logger.info("Broiler MQTT subscriptions ready (4 legacy patterns)");
    });
  });
  client.on("message", (topic, message, packet) => {
    // A retained live payload is not a fresh heartbeat; persist historical meter messages only.
    if (packet?.retain && topic.startsWith("coasther/telemetry/")) return;
    void service.handleMessage(topic, message, {
      io,
      heartbeat: !packet?.retain,
    });
  });
  client.on("error", () => logger.warn("Broiler MQTT connection error"));
  client.on("reconnect", () => logger.info("Broiler MQTT reconnecting"));
  let checking = false;
  const timer = setInterval(async () => {
    if (checking) return;
    checking = true;
    try {
      await service.checkDeviceStatus(io);
    } catch {
      logger.warn("Broiler device timeout check deferred");
    } finally {
      checking = false;
    }
  }, 30000);
  timer.unref();
  return {
    client,
    async stop() {
      clearInterval(timer);
      await new Promise((resolve) => client.end(false, {}, resolve));
    },
  };
}

module.exports = { start, topics };
