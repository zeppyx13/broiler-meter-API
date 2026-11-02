const { z } = require("zod");

const listAnnouncementsQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional().default(1),
  limit: z.coerce.number().int().positive().optional().default(10),
  is_active: z.coerce.number().int().min(0).max(1).optional(),
});

const createAnnouncementSchema = z.object({
  title: z.string().min(3).max(200),
  body: z.string().min(5),
  is_active: z.boolean().optional().default(true),
  start_at: z.string().datetime({ offset: true }).optional().nullable(),
  end_at: z.string().datetime({ offset: true }).optional().nullable(),
});

const updateAnnouncementSchema = z
  .object({
    title: z.string().min(3).max(200).optional(),
    body: z.string().min(5).optional(),
    is_active: z.boolean().optional(),
    start_at: z.string().datetime({ offset: true }).optional().nullable(),
    end_at: z.string().datetime({ offset: true }).optional().nullable(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field is required",
  });

const announcementIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

module.exports = {
  listAnnouncementsQuerySchema,
  createAnnouncementSchema,
  updateAnnouncementSchema,
  announcementIdParamSchema,
};
