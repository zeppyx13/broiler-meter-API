const { z } = require("zod");
const idParams = z.object({
  id: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
const querySchema = z
  .object({
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    source: z.enum(["real", "simulation", "all"]).default("real"),
    limit: z.coerce.number().int().min(1).max(500).default(100),
    before_id: z.coerce
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
  })
  .strict()
  .refine(
    (value) =>
      !value.from ||
      !value.to ||
      Date.parse(value.from) <= Date.parse(value.to),
    {
      message: "From must not follow to",
      path: ["from"],
    },
  );
module.exports = { idParams, querySchema };
