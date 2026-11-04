const { z } = require("zod");

const timestamp = z.iso
  .datetime({ offset: true })
  .transform((value) => new Date(Math.floor(Date.parse(value) / 1000) * 1000));
const counter = z
  .number()
  .finite()
  .nonnegative()
  .max(999999999999)
  .transform((value) => Number(value.toFixed(6)));
const readingSchema = z.object({
  reading_value: counter,
  recorded_at: timestamp,
});
const telemetrySchema = z
  .object({
    recorded_at: timestamp,
    flow_rate_lpm: z.number().finite().min(0).max(999999999.999).optional(),
    water_total_liter: counter.optional(),
    voltage: z.number().finite().min(0).max(999999999.999).optional(),
    current: z.number().finite().min(0).max(99999999.9999).optional(),
    power: z.number().finite().min(0).max(99999999999.999).optional(),
    energy_kwh_total: counter.optional(),
    frequency: z.number().finite().min(0).max(99999.999).optional(),
    pf: z.number().finite().min(0).max(1).optional(),
    ntp_synced: z.boolean().optional(),
  })
  .refine(
    (value) =>
      Object.keys(value).some(
        (key) => !["recorded_at", "ntp_synced"].includes(key),
      ),
    "Telemetry must contain a measurement",
  );

function parseMessage(topic, message) {
  if (typeof topic !== "string" || topic.length > 300)
    throw new Error("invalid_topic");
  const match =
    /^coasther\/(meter|telemetry|device)\/([A-Za-z0-9_.:-]{1,120})\/(reading|live|log|control-status)$/.exec(
      topic,
    );
  if (!match) return null;
  const [, kind, key, action] = match;
  if (
    !(
      (kind === "meter" && action === "reading") ||
      (kind === "telemetry" && action === "live") ||
      (kind === "device" && ["log", "control-status"].includes(action))
    )
  )
    return null;
  const buffer = Buffer.isBuffer(message) ? message : Buffer.from(message);
  if (buffer.length > 16384) throw new Error("payload_too_large");
  // Diagnostic text is nonessential and firmware does not escape arbitrary log strings as JSON.
  // Classify it before parsing; never store or forward raw log/control-status content.
  if (kind === "device") return { kind: "diagnostic", key, action };
  const raw = JSON.parse(buffer.toString("utf8"));
  return {
    kind,
    key,
    payload: (kind === "meter" ? readingSchema : telemetrySchema).parse(raw),
  };
}

module.exports = { readingSchema, telemetrySchema, parseMessage };
