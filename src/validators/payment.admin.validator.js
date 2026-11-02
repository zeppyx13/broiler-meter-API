const { z } = require("zod");

const listPaymentsQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional().default(1),
  limit: z.coerce.number().int().positive().optional().default(10),
  status: z.enum(["pending", "paid", "failed", "refunded"]).optional(),
  invoice_id: z.coerce.number().int().positive().optional(),
});

const paymentIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

module.exports = { listPaymentsQuerySchema, paymentIdParamSchema };
