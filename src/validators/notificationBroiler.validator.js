const { z } = require("zod");
const { id, idParam, listQuery } = require("./farm.validator");

const scopeQuery = z.object({ coop_id: id.optional() }).strict();
const querySchema = listQuery
  .extend({
    coop_id: id.optional(),
    channel: z.enum(["in_app", "email"]).default("in_app"),
    unread: z
      .enum(["true", "false"])
      .transform((value) => value === "true")
      .optional(),
  })
  .strict();
const emptyBody = z.object({}).strict();

module.exports = { idParam, scopeQuery, querySchema, emptyBody };
