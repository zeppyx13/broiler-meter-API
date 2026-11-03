require("dotenv").config({ quiet: true });
const db = require("../config/db");
const { verify } = require("../services/schemaCompatibility.service");
const { start } = require("../config/mqttBroiler");

// Passive subscription only: this script never publishes synthetic packets or control commands.
(async () => {
  await verify();
  const seconds = Number(process.env.MQTT_SMOKE_SECONDS || 15);
  if (!Number.isInteger(seconds) || seconds < 5 || seconds > 60)
    throw new Error("MQTT_SMOKE_SECONDS must be 5-60");
  const result = {
    connected: false,
    subscribed: false,
    received: { meter: 0, telemetry: 0, diagnostic: 0 },
  };
  const runtime = start();
  if (!runtime.client)
    throw new Error(
      "MQTT unavailable; check enabled flag and environment names",
    );
  try {
    runtime.client.on("connect", () => {
      result.connected = true;
    });
    runtime.client.on("packetreceive", (packet) => {
      if (
        packet.cmd === "suback" &&
        packet.granted?.every((qos) => qos !== 128)
      )
        result.subscribed = true;
    });
    runtime.client.on("message", (topic) => {
      if (topic.startsWith("coasther/meter/")) result.received.meter++;
      else if (topic.startsWith("coasther/telemetry/"))
        result.received.telemetry++;
      else result.received.diagnostic++;
    });
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    console.log(
      JSON.stringify(
        {
          ...result,
          observed_seconds: seconds,
          evidence:
            "Broker subscription and actual packet counts only; physical sensor accuracy still requires paired hardware verification",
        },
        null,
        2,
      ),
    );
    if (!result.connected || !result.subscribed) process.exitCode = 1;
  } finally {
    await runtime.stop();
  }
})()
  .catch((error) => {
    console.error(
      error.code ||
        "MQTT smoke could not complete; credentials and payloads are omitted",
    );
    process.exitCode = 1;
  })
  .finally(() => db.end());
