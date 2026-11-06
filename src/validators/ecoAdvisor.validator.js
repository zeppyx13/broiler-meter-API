const { z } = require("zod");
const { id, idParam, listQuery } = require("./farm.validator");

const scopeSchema = z
  .object({
    coop_id: id.optional(),
    source: z.enum(["real", "simulation"]).default("real"),
  })
  .strict();
const querySchema = listQuery
  .extend({
    ...scopeSchema.shape,
    status: z.enum(["new", "accepted", "dismissed"]).optional(),
    category: z.enum(["water", "electricity", "operations"]).optional(),
  })
  .strict();
const statusSchema = z
  .object({ status: z.enum(["accepted", "dismissed"]) })
  .strict();

module.exports = { idParam, scopeSchema, querySchema, statusSchema };
