const { z } = require("zod");

const myUsageQuerySchema = z.object({
  month: z
    .string()
    .regex(/^\d{4}-\d{2}$/, "month must be YYYY-MM")
    .optional(),
});

const myMeterReadingsQuerySchema = z.object({
  type: z.enum(["water", "electricity"]),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().positive().optional().default(200),
});

module.exports = { myUsageQuerySchema, myMeterReadingsQuerySchema };
