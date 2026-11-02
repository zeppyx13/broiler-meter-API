const { z } = require("zod");

const createComplaintSchema = z.object({
  title: z.string().min(3).max(160),
  description: z.string().min(5),
});

const updateComplaintSchema = z
  .object({
    title: z.string().min(3).max(160).optional(),
    description: z.string().min(5).optional(),
    status: z.enum(["open", "in_progress", "closed"]).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "Minimal 1 field harus diupdate",
  })
  .refine(
    (data) => {
      if (data.status && data.status !== "closed") return false;
      return true;
    },
    { message: "Tenant only allowed to set status to 'closed'" },
  );

const complaintIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

const listComplaintsQuerySchema = z.object({
  status: z.enum(["open", "in_progress", "closed"]).optional(),
  page: z.coerce.number().int().positive().optional().default(1),
  limit: z.coerce.number().int().positive().optional().default(10),
});
const adminUpdateComplaintSchema = z.object({
  status: z.enum(["open", "in_progress", "closed"]),
});

module.exports = {
  createComplaintSchema,
  updateComplaintSchema,
  complaintIdParamSchema,
  listComplaintsQuerySchema,
  adminUpdateComplaintSchema,
};
