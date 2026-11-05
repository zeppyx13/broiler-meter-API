const { z } = require("zod");

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const queryId = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const source = z.enum(["real", "simulation"]).default("real");
const idParam = z.object({ id: queryId }).strict();
const listQuery = z
  .object({
    coop_id: queryId.optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    before_id: queryId.optional(),
  })
  .strict();
const messagesQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(20),
    before_id: queryId.optional(),
  })
  .strict();
const createSchema = z
  .object({
    coop_id: id.optional(),
    title: z.string().trim().min(1).max(160).optional(),
  })
  .strict();
const sendSchema = z
  .object({
    coop_id: id.optional(),
    conversation_id: id.nullable().optional(),
    message: z.string().trim().min(1).max(2000),
    request_id: z.uuid().optional(),
    source,
  })
  .strict();

module.exports = {
  idParam,
  listQuery,
  messagesQuery,
  createSchema,
  sendSchema,
};
