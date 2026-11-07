const { z } = require("zod");

const id = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const source = z.enum(["real", "simulation"]);
const timestamp = z.iso
  .datetime({ offset: true })
  .refine(
    (v) => Date.parse(v) >= Date.UTC(2000, 0, 1),
    "Timestamp predates supported evidence",
  );
const params = z.object({ id }).strict();
const entryParams = z.object({ id, entryId: id }).strict();
const historyQuery = z
  .object({
    source: source.default("real"),
    minutes: z.coerce.number().int().min(1).max(120).default(30),
    bucket_seconds: z.coerce.number().int().min(5).max(300).default(30),
    before: timestamp.optional(),
  })
  .strict();
const listQuery = z
  .object({
    source: source.default("real"),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    before_id: id.optional(),
  })
  .strict();
const calibrationSchema = z
  .object({
    device_id: z.number().int().positive().nullable().optional(),
    type: z.enum(["water", "electricity"]),
    reference_value: z.number().positive().max(999999999),
    sensor_value: z.number().nonnegative().max(999999999),
    unit: z.enum(["L", "W"]),
    instrument_id: z.string().trim().min(2).max(120),
    method: z.string().trim().min(8).max(500),
    measured_at: timestamp,
    source,
    note: z.string().trim().max(1000).nullable().optional(),
  })
  .strict()
  .refine(
    (v) =>
      (v.type === "water" && v.unit === "L") ||
      (v.type === "electricity" && v.unit === "W"),
    "Water calibration uses L; electricity uses W",
  );
const verificationSchema = z
  .object({
    verification_state: z.literal("independently_verified"),
    evidence_note: z.string().trim().min(8).max(1000),
  })
  .strict();
const evidenceSchema = z
  .object({
    kind: z.enum(["packet_delivery", "guard_response", "field_trial"]),
    source,
    instrument_id: z.string().trim().min(2).max(120),
    method: z.string().trim().min(8).max(1000),
    observed_start: timestamp,
    observed_end: timestamp,
    evidence: z
      .object({
        reference: z.string().trim().min(8).max(1000),
        expected_packets: z.number().int().positive().max(100000000).optional(),
        received_packets: z
          .number()
          .int()
          .nonnegative()
          .max(100000000)
          .optional(),
        trusted_sequence_reference: z
          .string()
          .trim()
          .min(8)
          .max(255)
          .optional(),
        alert_id: z.number().int().positive().optional(),
        physical_onset_at: timestamp.optional(),
        detection_at: timestamp.optional(),
        observations: z.string().trim().max(2000).optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (Date.parse(v.observed_end) < Date.parse(v.observed_start))
      ctx.addIssue({
        code: "custom",
        path: ["observed_end"],
        message: "Observation end must follow start",
      });
    if (
      v.kind === "packet_delivery" &&
      (!v.evidence.expected_packets ||
        v.evidence.received_packets == null ||
        !v.evidence.trusted_sequence_reference ||
        v.evidence.received_packets > v.evidence.expected_packets)
    )
      ctx.addIssue({
        code: "custom",
        path: ["evidence"],
        message:
          "Delivery measurement requires trusted sequence evidence and valid packet counts",
      });
    if (
      v.kind === "guard_response" &&
      (!v.evidence.alert_id ||
        !v.evidence.physical_onset_at ||
        !v.evidence.detection_at ||
        Date.parse(v.evidence.detection_at) <
          Date.parse(v.evidence.physical_onset_at))
    )
      ctx.addIssue({
        code: "custom",
        path: ["evidence"],
        message:
          "Guard measurement requires an alert, physical onset and subsequent detection timestamp",
      });
    if (
      v.kind === "guard_response" &&
      v.evidence.physical_onset_at &&
      v.evidence.detection_at &&
      (Date.parse(v.evidence.physical_onset_at) <
        Date.parse(v.observed_start) ||
        Date.parse(v.evidence.detection_at) > Date.parse(v.observed_end))
    )
      ctx.addIssue({
        code: "custom",
        path: ["evidence"],
        message:
          "Physical onset and detection must lie inside the recorded observation interval",
      });
  });
const commands = ["status", "sync_ntp", "reboot", "clear_buf", "reset_nvs"];
const maintenanceSchema = z
  .object({
    device_id: z.number().int().positive(),
    command: z.enum(commands),
    request_id: z.uuid(),
    source,
    confirmation: z.literal("MAINTENANCE ACCEPTED"),
    reason: z.string().trim().min(8).max(500),
    typed_confirmation: z.string().max(255).optional(),
  })
  .strict();
const maintenanceQuery = z.object({ source: source.default("real") }).strict();
const maintenanceRequestParams = z.object({ id, requestId: z.uuid() }).strict();
const maintenanceAcceptanceSchema = z
  .object({
    device_id: z.number().int().positive(),
    command: z.enum(commands),
    accepted: z.boolean(),
    request_id: z.uuid(),
    evidence_reference: z.string().trim().min(8).max(255),
    note: z.string().trim().min(16).max(1000),
    confirmation: z.string().max(255).optional(),
  })
  .strict();

module.exports = {
  params,
  entryParams,
  emptyQuery: z.object({}).strict(),
  historyQuery,
  listQuery,
  calibrationSchema,
  verificationSchema,
  evidenceSchema,
  maintenanceSchema,
  maintenanceQuery,
  maintenanceRequestParams,
  maintenanceAcceptanceSchema,
  commands,
};
