const { z } = require("zod");

const includeSimulation = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");
const summaryQuery = z
  .object({
    coop_id: z.coerce
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
    include_simulation: includeSimulation,
  })
  .strict();
const chartsQuery = summaryQuery
  .extend({
    metric: z.enum(["water", "electricity", "all"]).default("all"),
    range: z.enum(["cycle"]).default("cycle"),
    start_date: z.iso.date().optional(),
    end_date: z.iso.date().optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.start_date && data.end_date) {
      const days =
        (Date.parse(data.end_date) - Date.parse(data.start_date)) / 86400000 +
        1;
      if (days < 1 || days > 366) {
        ctx.addIssue({
          code: "custom",
          path: ["end_date"],
          message: "Date range must contain between 1 and 366 days",
        });
      }
    }
  });

module.exports = { summaryQuery, chartsQuery };
