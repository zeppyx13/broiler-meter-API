const mqtt = require("mqtt");
const logger = require("./logger");
const service = require("../services/iotBroiler.service");
const diagnostics = require("../utils/mqttDiagnostics");
const phase3 = require("../services/broilerPhase3Runtime.service");
const relays = require("../services/relayBroiler.service");
let activeRuntime = null;

const topics = [
  "coasther/meter/+/reading",
  "coasther/telemetry/+/live",
  "coasther/device/+/log",
  "coasther/device/+/control-status",
];

function start({ io, connect = mqtt.connect } = {}) {
  if (activeRuntime) return activeRuntime;
  phase3.configure({ io });
  // One timer drives independent jobs, even if MQTT is unavailable/offline.
  // SMTP has its own in-flight gate and cannot hold the Guard watchdog.
  const timer = setInterval(() => {
    void phase3.tick();
  }, 30000);
  timer.unref();
  let client = null;
  activeRuntime = {
    get client() {
      return client;
    },
    async stop() {
      clearInterval(timer);
      relays.configure();
      await phase3.stop();
      if (client)
        await new Promise((resolve) => client.end(false, {}, resolve));
      activeRuntime = null;
    },
  };
  relays.configure({ io });
  if (process.env.BROILER_MQTT_ENABLED === "false") {
    logger.info("Broiler MQTT disabled by environment");
    return activeRuntime;
  }
  if (
    !process.env.MQTT_HOST ||
    !process.env.MQTT_USERNAME ||
    !process.env.MQTT_PASSWORD
  ) {
    logger.warn("Broiler MQTT not started: MQTT environment is incomplete");
    return activeRuntime;
  }
  client = connect({
    host: process.env.MQTT_HOST,
    port: Number(process.env.MQTT_PORT || 8883),
    username: process.env.MQTT_USERNAME,
    password: process.env.MQTT_PASSWORD,
    protocol: "mqtts",
    rejectUnauthorized: true,
    reconnectPeriod: 5000,
    connectTimeout: 15000,
    resubscribe: false,
    queueQoSZero: false,
  });
  relays.configure({ client, io });
  client.on("connect", () => {
    logger.info(`Broiler MQTT connected pid=${process.pid}`);
    client.subscribe(topics, { qos: 1 }, (error, grants) => {
      if (error || grants?.some((grant) => grant.qos === 128))
        diagnostics.report(
          {
            stage: "mqtt_subscribe",
            outcome: "subscription_failed",
            reason_code: "MQTT_SUBSCRIPTION_FAILED",
          },
          error,
        );
      else logger.info("Broiler MQTT subscriptions ready (4 legacy patterns)");
    });
  });
  client.on("message", (topic, message, packet) => {
    // A retained live payload is not a fresh heartbeat; persist historical meter messages only.
    if (packet?.retain && topic.startsWith("coasther/telemetry/")) return;
    void service.handleMessage(topic, message, {
      io,
      heartbeat: !packet?.retain,
      retained: Boolean(packet?.retain),
    });
  });
  client.on("error", (error) =>
    diagnostics.report(
      {
        stage: "mqtt_connect",
        outcome: "connection_error",
        reason_code: "MQTT_CONNECTION_ERROR",
      },
      error,
    ),
  );
  client.on("reconnect", () => logger.info("Broiler MQTT reconnecting"));
  return activeRuntime;
}

module.exports = { start, topics };
