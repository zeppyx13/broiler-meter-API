const { z } = require("zod");

const listMyInvoicesQuerySchema = z.object({
  status: z.enum(["unpaid", "paid", "overdue", "cancelled"]).optional(),
  page: z.coerce.number().int().positive().optional().default(1),
  limit: z.coerce.number().int().positive().optional().default(10),
});

module.exports = { listMyInvoicesQuerySchema };
