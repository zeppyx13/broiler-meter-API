const { z } = require("zod");
const { id, idParam, listQuery } = require("./farm.validator");

const fields = {
  code: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(150),
  capacity_birds: z.number().int().min(1).max(4294967295).nullable(),
  description: z.string().max(16000).nullable(),
  status: z.enum(["active", "inactive"]),
};
const createSchema = z
  .object({
    farm_id: id,
    ...fields,
    capacity_birds: fields.capacity_birds.default(null),
    description: fields.description.default(null),
    status: fields.status.default("active"),
  })
  .strict();
const updateSchema = z
  .object(fields)
  .partial()
  .strict()
  .refine(
    (value) => Object.keys(value).length > 0,
    "Provide at least one field",
  );
const querySchema = listQuery.extend({ farm_id: id.optional() }).strict();

module.exports = { idParam, createSchema, updateSchema, querySchema };
