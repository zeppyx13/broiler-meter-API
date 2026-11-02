const { z } = require("zod");

const createReviewSchema = z.object({
  rating: z.coerce.number().int().min(1).max(5),
  comment: z.string().min(3).optional(),
});

const reviewIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

module.exports = {
  createReviewSchema,
  reviewIdParamSchema,
};
