const { z } = require("zod");

const createMeterSchema = z.object({
  room_id: z.coerce.number().int().positive(),
  type: z.enum(["water", "electricity"]),
  device_uid: z.string().min(3).max(120),
  unit: z.enum(["m3", "kwh"]),
  is_active: z.boolean().optional().default(true),
  installed_at: z.string().datetime({ offset: true }).optional().nullable(),
});

const updateMeterSchema = z
  .object({
    device_uid: z.string().min(3).max(120).optional(),
    unit: z.enum(["m3", "kwh"]).optional(),
    is_active: z.boolean().optional(),
    installed_at: z.string().datetime({ offset: true }).optional().nullable(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field is required",
  });

const meterIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

const listMetersQuerySchema = z.object({
  room_id: z.coerce.number().int().positive().optional(),
  type: z.enum(["water", "electricity"]).optional(),
  is_active: z.coerce.number().int().min(0).max(1).optional(),
});

module.exports = {
  createMeterSchema,
  updateMeterSchema,
  meterIdParamSchema,
  listMetersQuerySchema,
};
