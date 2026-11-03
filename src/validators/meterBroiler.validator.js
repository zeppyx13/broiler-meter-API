const { z } = require("zod");
const { id, idParam, listQuery } = require("./farm.validator");
const { topicIdentity, activeFilter } = require("./device.validator");

const installedAt = z
  .string()
  .datetime({ offset: true })
  .refine(
    (value) => Number(value.slice(0, 4)) >= 1000,
    "Date must fit the database DATETIME range",
  )
  .nullable();
const createSchema = z
  .object({
    device_id: id,
    meter_uid: topicIdentity,
    type: z.enum(["water", "electricity"]),
    channel: z
      .string()
      .trim()
      .min(1)
      .max(40)
      .regex(/^[a-z][a-z0-9_-]*$/)
      .default("main"),
    unit: z.enum(["liter", "kwh"]),
    is_active: z.boolean().default(true),
    installed_at: installedAt.default(null),
  })
  .strict()
  .superRefine((data, context) => {
    if (
      (data.type === "water" && data.unit !== "liter") ||
      (data.type === "electricity" && data.unit !== "kwh")
    ) {
      context.addIssue({
        code: "custom",
        path: ["unit"],
        message: "Water uses liter; electricity uses kwh",
      });
    }
    if (
      data.type === "electricity" &&
      !["main", "total", "phase_a", "phase_b", "phase_c"].includes(data.channel)
    ) {
      context.addIssue({
        code: "custom",
        path: ["channel"],
        message:
          "Electrical channel must be main, total, phase_a, phase_b or phase_c",
      });
    }
  });
const updateSchema = z
  .object({ is_active: z.boolean(), installed_at: installedAt })
  .partial()
  .strict()
  .refine(
    (value) => Object.keys(value).length > 0,
    "Provide at least one field",
  );
const querySchema = listQuery
  .extend({
    coop_id: id.optional(),
    device_id: id.optional(),
    type: z.enum(["water", "electricity"]).optional(),
    is_active: activeFilter.optional(),
  })
  .strict();

module.exports = { idParam, createSchema, updateSchema, querySchema };
