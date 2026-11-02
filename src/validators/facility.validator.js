const { z } = require("zod");

const createFacilitySchema = z.object({
  name: z.string().min(2).max(80),
});

const updateFacilitySchema = z.object({
  name: z.string().min(2).max(80),
});

const facilityIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

module.exports = {
  createFacilitySchema,
  updateFacilitySchema,
  facilityIdParamSchema,
};
