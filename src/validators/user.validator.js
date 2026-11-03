const { z } = require("zod");

const updateMeSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    phone: z.string().max(30).nullable().optional(),
    avatar_url: z.string().url().max(500).nullable().optional(),
    default_coop_id: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .nullable()
      .optional(),
    fcm_token: z.string().min(1).max(255).nullable().optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field is required",
  });

module.exports = { updateMeSchema };
