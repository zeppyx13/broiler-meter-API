const { z } = require("zod");

const createMidtransPaymentSchema = z.object({
  invoice_id: z.coerce.number().int().positive(),
});

module.exports = { createMidtransPaymentSchema };
