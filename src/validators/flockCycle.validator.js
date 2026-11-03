const { z } = require("zod");

const id = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const date = z.iso.date();
const idParams = z.object({ id });
const coopQuery = z.object({ coop_id: id }).strict();
const listQuery = z
  .object({
    coop_id: id,
    status: z.enum(["planned", "active", "completed", "cancelled"]).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER)
      .default(0),
  })
  .strict();

const createSchema = z
  .object({
    coop_id: id,
    cycle_code: z.string().trim().min(1).max(60),
    placement_date: date.default(new Date().toISOString().split("T")[0]),
    planned_harvest_date: date.nullable().optional(),
    initial_population: z.number().int().positive().max(4294967295),
    notes: z.string().trim().max(10000).nullable().optional(),
  })
  .strict()
  .refine(
    (data) =>
      !data.planned_harvest_date ||
      data.planned_harvest_date >= data.placement_date,
    {
      message: "Planned harvest cannot precede placement",
      path: ["planned_harvest_date"],
    },
  );

const eventSchema = z
  .object({
    event_type: z.enum(["mortality", "culling", "adjustment", "harvest"]),
    population_change: z
      .number()
      .int()
      .min(-2147483648)
      .max(2147483647)
      .refine((value) => value !== 0, "Population change cannot be zero"),
    event_date: date.optional(),
    notes: z.string().trim().min(1).max(255).optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.event_type !== "adjustment" && data.population_change > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["population_change"],
        message: "Mortality, culling and harvest must reduce population",
      });
    }
    if (data.event_type === "adjustment" && !data.notes) {
      ctx.addIssue({
        code: "custom",
        path: ["notes"],
        message: "Adjustment requires a reason",
      });
    }
  });

const completeSchema = z
  .object({ actual_harvest_date: date.optional() })
  .strict();

module.exports = {
  idParams,
  coopQuery,
  listQuery,
  createSchema,
  eventSchema,
  completeSchema,
};
