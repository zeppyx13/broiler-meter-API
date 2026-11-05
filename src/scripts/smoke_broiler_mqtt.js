const mqtt = require("mqtt");

const topics = [
  "coasther/meter/+/reading",
  "coasther/telemetry/+/live",
  "coasther/device/+/log",
  "coasther/device/+/control-status",
];

// Independent observer: no application runtime, ingestion, database or workers.
function observe({ env = process.env, connect = mqtt.connect } = {}) {
  const seconds = Number(env.MQTT_SMOKE_SECONDS || 15);
  const port = Number(env.MQTT_PORT || 8883);
  const result = {
    connected: false,
    subscribed: false,
    received: { meter: 0, telemetry: 0, diagnostic: 0, control_status: 0 },
    observed_seconds: 0,
    evidence: "Passive broker observation only; no persistence, publication or physical sensor verification",
  };
  const invalid =
    !Number.isInteger(seconds) || seconds < 5 || seconds > 60
      ? "invalid_observation_duration"
      : !Number.isInteger(port) || port < 1 || port > 65535
        ? "invalid_mqtt_port"
        : env.BROILER_MQTT_ENABLED === "false"
          ? "mqtt_disabled"
          : !env.MQTT_HOST || !env.MQTT_USERNAME || !env.MQTT_PASSWORD
            ? "mqtt_not_configured"
            : null;
  if (invalid) return Promise.resolve({ ...result, success: false, reason: invalid });

  return new Promise((resolve) => {
    let client;
    let settled = false;
    const started = Date.now();
    const finish = (reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      result.observed_seconds = Math.min(seconds, (Date.now() - started) / 1000);
      try {
        client?.end(true);
      } catch {
        reason ||= "mqtt_close_failed";
      }
      resolve({ ...result, success: !reason, reason: reason || null });
    };
    const timer = setTimeout(
      () => finish(!result.connected ? "connection_not_observed" : !result.subscribed ? "subscription_not_confirmed" : null),
      seconds * 1000,
    );
    try {
      client = connect({
        host: env.MQTT_HOST,
        port,
        username: env.MQTT_USERNAME,
        password: env.MQTT_PASSWORD,
        protocol: "mqtts",
        rejectUnauthorized: true,
        reconnectPeriod: 0,
        connectTimeout: Math.min(15000, seconds * 1000),
        resubscribe: false,
        queueQoSZero: false,
        clean: true,
      });
      client.on("error", () => finish("mqtt_connection_error"));
      client.on("close", () => finish("mqtt_connection_closed"));
      client.on("connect", () => {
        if (settled) return;
        result.connected = true;
        try {
          client.subscribe(topics, { qos: 0 }, (error, grants) => {
            if (settled) return;
            if (error || !Array.isArray(grants) || grants.length !== topics.length || grants.some((grant) => ![0, 1, 2].includes(grant?.qos))) {
              finish("mqtt_subscription_failed");
              return;
            }
            result.subscribed = true;
          });
        } catch {
          finish("mqtt_subscription_failed");
        }
      });
      client.on("message", (topic) => {
        if (settled) return;
        if (/^coasther\/meter\/[^/]+\/reading$/.test(topic)) result.received.meter++;
        else if (/^coasther\/telemetry\/[^/]+\/live$/.test(topic)) result.received.telemetry++;
        else if (/^coasther\/device\/[^/]+\/log$/.test(topic)) result.received.diagnostic++;
        else if (/^coasther\/device\/[^/]+\/control-status$/.test(topic)) result.received.control_status++;
      });
    } catch {
      finish("mqtt_connection_error");
    }
  });
}

async function main() {
  require("dotenv").config({ quiet: true });
  const result = await observe();
  console.log(JSON.stringify(result, null, 2));
  if (!result.success) process.exitCode = 1;
}

if (require.main === module) {
  main().catch(() => {
    console.error("MQTT smoke could not complete; credentials and payloads are omitted");
    process.exitCode = 1;
  });
}

module.exports = { observe };
