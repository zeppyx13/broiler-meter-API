const { z } = require("zod");
const { id, idParam, listQuery } = require("./farm.validator");

const createSchema = z
  .object({
    device_id: id,
    channel: z.literal(1).default(1),
    name: z.string().trim().min(1).max(100),
    purpose: z.enum(["light", "heater", "other"]).default("other"),
    is_enabled: z.boolean().default(true),
  })
  .strict();
const updateSchema = createSchema
  .omit({ device_id: true, channel: true })
  .partial()
  .strict()
  .refine(
    (value) => Object.keys(value).length > 0,
    "Provide at least one field",
  );
const querySchema = listQuery
  .extend({ device_id: id.optional(), coop_id: id.optional() })
  .strict();
const commandSchema = z.object({ command: z.enum(["on", "off"]) }).strict();
const timestamp = z
  .union([
    z.date(),
    z.iso.datetime({ offset: true }).transform((value) => new Date(value)),
  ])
  .transform((value) => new Date(Math.floor(value.getTime() / 1000) * 1000));
const results = [
  "relay_on_executed",
  "relay_off_executed",
  "rejected_invalid_format",
  "rejected_invalid_token",
  "relay_state_sync",
  "status_sent",
  "reset_nvs_executed",
  "ntp_sync_ok",
  "ntp_sync_failed",
  "clear_buf_executed",
  "reboot_executed",
  "unknown_command",
];
const controlStatusSchema = z
  .object({
    room_id: z.number().int().nonnegative().optional(),
    relay_cutoff: z.boolean(),
    relay_state: z.enum(["on", "off"]),
    source: z.enum(["mqtt_command", "mqtt_connect"]),
    result: z.enum(results),
    recorded_at: timestamp,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.relay_cutoff !== (value.relay_state === "off")) {
      ctx.addIssue({
        code: "custom",
        path: ["relay_state"],
        message: "Relay state and cutoff disagree",
      });
    }
    if (
      (value.result === "relay_on_executed" && value.relay_state !== "on") ||
      (value.result === "relay_off_executed" && value.relay_state !== "off")
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["result"],
        message: "Execution result and observed state disagree",
      });
    }
    if (
      (value.source === "mqtt_connect") !==
      (value.result === "relay_state_sync")
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["source"],
        message: "Relay synchronization source is inconsistent",
      });
    }
  });
const telemetryStateSchema = z.object({
  relay_cutoff: z.boolean(),
  recorded_at: timestamp,
});

module.exports = {
  idParam,
  listQuery,
  querySchema,
  createSchema,
  updateSchema,
  commandSchema,
  controlStatusSchema,
  telemetryStateSchema,
};
