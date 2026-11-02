const { z } = require("zod");

const createRoomSchema = z.object({
  number: z.string().min(1).max(10),
  floor: z.number().int().nonnegative().optional().nullable(),
  price_monthly: z.number().int().nonnegative(),
  deposit: z.number().int().nonnegative().optional().default(0),
  is_available: z.boolean().optional().default(true),
  description: z.string().optional().nullable(),
  main_image_url: z.string().max(500).optional().nullable(),
  facility_ids: z.array(z.number().int().positive()).optional().default([]),
});

const updateRoomSchema = z
  .object({
    number: z.string().min(1).max(10).optional(),
    floor: z.number().int().nonnegative().optional().nullable(),
    price_monthly: z.number().int().nonnegative().optional(),
    deposit: z.number().int().nonnegative().optional(),
    is_available: z.boolean().optional(),
    description: z.string().optional().nullable(),
    main_image_url: z.string().max(500).optional().nullable(),
    facility_ids: z.array(z.number().int().positive()).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "Minimal 1 field harus diupdate",
  });

const roomIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

const listRoomsQuerySchema = z.object({
  search: z.string().optional(),
  is_available: z
    .union([z.literal("0"), z.literal("1")])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "1")),
  page: z.coerce.number().int().positive().optional().default(1),
  limit: z.coerce.number().int().positive().optional().default(20),
});

module.exports = {
  createRoomSchema,
  updateRoomSchema,
  roomIdParamSchema,
  listRoomsQuerySchema,
};
