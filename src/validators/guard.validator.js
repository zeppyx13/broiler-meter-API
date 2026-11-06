const { z } = require("zod");

const id = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const ruleCode = z.enum([
  "device_offline",
  "suspected_power_anomaly",
  "suspected_water_anomaly",
  "no_water_flow",
  "voltage_abnormal",
  "low_power_factor",
  "daily_record_missing",
  "cycle_overdue",
]);
const severity = z.enum(["info", "warning", "critical"]);
const common = {
  recovery_window_sec: z.number().int().min(10).max(600).default(30),
  max_sample_gap_sec: z.number().int().min(5).max(120).default(30),
  min_samples: z.number().int().min(2).max(360).default(3),
};
const parameters = {
  voltage_abnormal: z.object({
    ...common,
    min_voltage_v: z.number().positive().max(1000).default(198),
    max_voltage_v: z.number().positive().max(1000).default(242),
    recovery_min_voltage_v: z.number().positive().max(1000).default(205),
    recovery_max_voltage_v: z.number().positive().max(1000).default(235),
  }).strict().refine((p) => p.min_voltage_v < p.recovery_min_voltage_v && p.recovery_min_voltage_v < p.recovery_max_voltage_v && p.recovery_max_voltage_v < p.max_voltage_v, "Recovery voltage band must lie strictly inside the alarm band"),
  low_power_factor: z.object({
    ...common,
    min_power_factor: z.number().positive().lt(1).default(0.8),
    recovery_power_factor: z.number().positive().max(1).default(0.9),
    min_power_w: z.number().positive().max(10000000).default(10),
  }).strict().refine((p) => p.recovery_power_factor > p.min_power_factor, "Recovery PF must exceed low PF threshold"),
  daily_record_missing: z.object({ due_hour: z.number().int().min(0).max(23).default(16) }).strict(),
  cycle_overdue: z.object({ grace_days: z.number().int().min(0).max(30).default(0) }).strict(),
  device_offline: z
    .object({
      stale_after_seconds: z.number().int().min(30).max(86400).default(120),
      recovery_window_sec: z.number().int().min(10).max(600).default(60),
      device_id: id.optional(),
    })
    .strict(),
  suspected_power_anomaly: z
    .object({
      ...common,
      min_power_w: z.number().positive().max(10000000),
      recovery_power_w: z.number().positive().max(10000000),
      min_voltage_v: z.number().positive().max(1000).default(100),
    })
    .strict()
    .refine((data) => data.recovery_power_w > data.min_power_w, {
      path: ["recovery_power_w"],
      message: "Recovery power must exceed the low-power threshold",
    }),
  suspected_water_anomaly: z
    .object({
      ...common,
      max_flow_lpm: z.number().positive().max(100000),
      recovery_flow_lpm: z.number().min(0).max(100000),
    })
    .strict()
    .refine((data) => data.recovery_flow_lpm < data.max_flow_lpm, {
      path: ["recovery_flow_lpm"],
      message: "Recovery flow must be below the high-flow threshold",
    }),
  no_water_flow: z
    .object({
      ...common,
      max_flow_lpm: z.number().min(0).max(1000).default(0.1),
      recovery_flow_lpm: z.number().positive().max(100000).default(0.5),
      expected_flow: z.boolean().default(false),
      expected_flow_until: z.iso.datetime({ offset: true }).optional(),
      context_note: z.string().trim().min(8).max(255).optional(),
    })
    .strict()
    .refine((data) => data.recovery_flow_lpm > data.max_flow_lpm, {
      path: ["recovery_flow_lpm"],
      message: "Recovery flow must exceed the no-flow threshold",
    }),
};
const fields = {
  name: z.string().trim().min(2).max(150),
  severity,
  parameters_json: z.record(z.string(), z.unknown()),
  evaluation_window_sec: z.number().int().min(10).max(1800),
  cooldown_sec: z.number().int().min(0).max(86400),
  is_active: z.boolean(),
};

function validateRule(input) {
  const parsed = z
    .object({ coop_id: id, rule_code: ruleCode, ...fields })
    .strict()
    .parse(input);
  parsed.parameters_json = parameters[parsed.rule_code].parse(
    parsed.parameters_json,
  );
  if (parsed.rule_code === "device_offline" && parsed.severity === "critical") {
    throw new z.ZodError([
      {
        code: "custom",
        path: ["severity"],
        message:
          "Missing telemetry alone supports info/warning, not a critical physical-fault claim",
      },
    ]);
  }
  if (["daily_record_missing", "cycle_overdue"].includes(parsed.rule_code) && parsed.severity === "critical") {
    throw new z.ZodError([{ code: "custom", path: ["severity"], message: "Production reminders do not establish a critical physical condition" }]);
  }
  if (
    parsed.severity === "critical" &&
    parsed.evaluation_window_sec <
      (parsed.rule_code === "no_water_flow" ? 300 : 120)
  ) {
    throw new z.ZodError([
      {
        code: "custom",
        path: ["evaluation_window_sec"],
        message:
          "Critical severity requires a sustained observation window (120 seconds, or 300 seconds for no-flow)",
      },
    ]);
  }
  if (
    parsed.rule_code === "no_water_flow" &&
    parsed.is_active &&
    (!parsed.parameters_json.expected_flow ||
      !parsed.parameters_json.expected_flow_until ||
      !parsed.parameters_json.context_note)
  ) {
    throw new z.ZodError([
      {
        code: "custom",
        path: ["parameters_json"],
        message:
          "Enabling no-flow requires explicit expected flow, expiry and contextual reason",
      },
    ]);
  }
  return parsed;
}

const createSchema = z
  .object({
    coop_id: id,
    rule_code: ruleCode,
    ...fields,
    severity: severity.default("warning"),
    evaluation_window_sec: fields.evaluation_window_sec.default(60),
    cooldown_sec: fields.cooldown_sec.default(900),
    is_active: fields.is_active.optional(),
  })
  .strict()
  .transform((input, ctx) => {
    try {
      return validateRule({
        ...input,
        is_active: input.is_active ?? input.rule_code !== "no_water_flow",
      });
    } catch (error) {
      if (!(error instanceof z.ZodError)) throw error;
      for (const issue of error.issues) ctx.addIssue(issue);
      return z.NEVER;
    }
  });
const updateSchema = z
  .object(fields)
  .partial()
  .strict()
  .refine((data) => Object.keys(data).length > 0, "Provide at least one field");
const listQuery = z
  .object({
    coop_id: id.optional(),
    page: id.max(1000000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();
const alertsQuery = listQuery
  .extend({
    status: z.enum(["active", "acknowledged", "resolved"]).optional(),
    severity: severity.optional(),
    source: z.enum(["real", "simulation", "all"]).default("real"),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
  })
  .strict()
  .refine(
    (data) =>
      !data.from || !data.to || Date.parse(data.from) <= Date.parse(data.to),
    "from must not follow to",
  );
const idParams = z.object({ id }).strict();
const resolveSchema = z
  .object({ note: z.string().trim().min(8).max(500) })
  .strict();
const ackSchema = z.object({}).strict();
const statusQuery = listQuery
  .extend({ source: z.enum(["rule", "simulation"]).default("rule") })
  .strict();

module.exports = {
  createSchema,
  updateSchema,
  listQuery,
  alertsQuery,
  statusQuery,
  idParams,
  resolveSchema,
  ackSchema,
  validateRule,
};
