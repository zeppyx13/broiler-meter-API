const { z } = require("zod");
const id = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const source = z.enum(["real", "simulation"]).default("real");
const querySchema = z
  .object({
    coop_id: id.optional(),
    source,
    window_days: z.coerce.number().int().min(3).max(30).default(7),
  })
  .strict();
const generateSchema = z
  .object({
    coop_id: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
    source,
    window_days: z.number().int().min(3).max(30).default(7),
  })
  .strict();
const historySchema = z
  .object({
    coop_id: id.optional(),
    source,
    flock_cycle_id: id.optional(),
    metric: z
      .enum(["water_liters", "energy_kwh", "electricity_cost_idr"])
      .optional(),
    horizon: z.enum(["next_day", "until_harvest"]).optional(),
    page: z.coerce.number().int().min(1).max(1000000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

module.exports = { querySchema, generateSchema, historySchema };
