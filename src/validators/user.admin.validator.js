const { z } = require("zod");

const userIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

const updateUserAdminSchema = z
  .object({
    name: z.string().min(2).max(120).optional(),
    phone: z.string().max(20).optional().nullable(),
    role: z.enum(["tenant", "admin", "manager"]).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field is required",
  });

const listUsersQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional().default(1),
  limit: z.coerce.number().int().positive().optional().default(10),
  role: z.enum(["tenant", "admin", "manager"]).optional(),
  search: z.string().optional(),
});

module.exports = {
  userIdParamSchema,
  updateUserAdminSchema,
  listUsersQuerySchema,
};
