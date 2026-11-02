const { z } = require("zod");

const meterReadingSchema = z.object({
  reading_value: z.coerce.number().positive(),
  recorded_at: z.string().datetime().optional(),
});

module.exports = { meterReadingSchema };
