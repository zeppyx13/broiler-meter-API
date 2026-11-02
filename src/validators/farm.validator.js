const { z } = require("zod");

const id = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const idParam = z.object({ id }).strict();
const memberParam = z.object({ id, userId: id }).strict();
const listQuery = z.object({
  page: z.coerce.number().int().min(1).max(1000000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
}).strict();
const timezone = z.string().max(64).refine((value) => {
  try { new Intl.DateTimeFormat("en", { timeZone: value }).format(); return true; }
  catch { return false; }
}, "Invalid IANA timezone");
const rate = z.number().min(0).max(9999999999.99).multipleOf(0.01);
const fields = {
  name: z.string().trim().min(1).max(150),
  location_text: z.string().trim().max(255).nullable(),
  timezone,
  electricity_rate_idr_per_kwh: rate,
  water_rate_idr_per_m3: rate,
};
const createSchema = z.object({
  ...fields,
  location_text: fields.location_text.default(null),
  timezone: timezone.default("Asia/Makassar"),
  electricity_rate_idr_per_kwh: rate.default(0),
  water_rate_idr_per_m3: rate.default(0),
}).strict();
const updateSchema = z.object({ ...fields, is_active: z.boolean() }).partial().strict()
  .refine((value) => Object.keys(value).length > 0, "Provide at least one field");
const memberRole = z.enum(["manager", "operator", "viewer"]);
const addMemberSchema = z.object({ user_id: id, role: memberRole.default("operator") }).strict();
const updateMemberSchema = z.object({ role: memberRole }).strict();

module.exports = { id, idParam, memberParam, listQuery, createSchema, updateSchema, addMemberSchema, updateMemberSchema };
