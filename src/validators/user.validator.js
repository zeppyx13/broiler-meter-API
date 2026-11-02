const { z } = require("zod");

const updateMeSchema = z.object({
  name: z.string().min(2).optional(),
  phone: z.string().min(8).max(30).optional(),
  avatar_url: z.string().url().optional(),
});

module.exports = { updateMeSchema };
