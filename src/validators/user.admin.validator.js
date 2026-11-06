const { z } = require("zod");

const userIdParamSchema = z.object({
  id: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

const updateUserAdminSchema = z
  .object({
    name: z.string().min(2).max(120).optional(),
    phone: z.string().max(30).optional().nullable(),
    role: z.enum(["operator", "admin", "manager"]).optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field is required",
  });

const listUsersQuerySchema = z
  .object({
    page: z.coerce.number().int().positive().max(1000000).optional().default(1),
    limit: z.coerce.number().int().positive().max(100).optional().default(10),
    role: z.enum(["operator", "admin", "manager"]).optional(),
    search: z.string().max(190).optional(),
  })
  .strict();

module.exports = {
  userIdParamSchema,
  updateUserAdminSchema,
  listUsersQuerySchema,
};
