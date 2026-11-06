const { z } = require("zod");
const id = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const idParam = z.object({ id }).strict();
const dailyParam = z.object({ id, date: z.iso.date() }).strict();
const resourceParam = z.object({ id, resourceId: id }).strict();
const assignmentParam = z.object({ id, userId: id }).strict();
const emptyQuery = z.object({}).strict();
const sourceQuery = z.object({ source: z.enum(["real", "simulation"]).default("real") }).strict();
const recordSchema = z.object({
  dead: z.number().int().min(0).max(100000000),
  culled: z.number().int().min(0).max(100000000),
  avg_weight_g: z.number().positive().max(100000).nullable().optional(),
  feed_kg: z.number().min(0).max(100000000).nullable().optional(),
  note: z.string().trim().max(5000).nullable().optional(),
  request_id: z.uuid().optional(),
  expected_revision: z.number().int().min(0).optional(),
}).strict();
const voidSchema = z.object({ request_id: z.uuid().optional(), expected_revision: z.number().int().min(1), note: z.string().trim().min(8).max(500) }).strict();
const assignmentSchema = z.object({ user_id: id, can_operate: z.boolean(), relay_operate: z.boolean().default(false) }).strict().refine((value) => !value.relay_operate || value.can_operate, "Relay operation also requires coop operation permission");
const schedule = z.object({ start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/) }).strict();
const equipmentFields = {
  name: z.string().trim().min(1).max(150),
  type: z.enum(["fan", "brooder", "heater", "light", "pump", "other"]),
  count: z.number().int().min(1).max(100000),
  rated_watt: z.number().min(0).max(100000000),
  is_expected_active: z.boolean(),
  unit: z.string().trim().min(1).max(30),
  schedule: schedule.nullable(),
  is_active: z.boolean(),
};
const equipmentCreate = z.object({ ...equipmentFields, count: equipmentFields.count.default(1), is_expected_active: z.boolean().default(false), unit: equipmentFields.unit.default("unit"), schedule: schedule.nullable().default(null), is_active: z.boolean().default(true) }).strict();
const equipmentUpdate = z.object(equipmentFields).partial().strict().refine((value) => Object.keys(value).length > 0, "At least one field is required");
const profileSchema = z.object({ strain: z.string().trim().min(1).max(100).nullable(), harvest_target_days: z.number().int().min(1).max(365).nullable() }).partial().strict().refine((value) => Object.keys(value).length > 0, "At least one field is required");
const harvestSchema = z.object({harvested_count:z.number().int().min(0).max(4294967295),actual_harvest_date:z.iso.date(),notes:z.string().trim().max(255).optional(),request_id:z.uuid()}).strict();
module.exports = { idParam, dailyParam, resourceParam, assignmentParam, emptyQuery, sourceQuery, recordSchema, voidSchema, assignmentSchema, equipmentCreate, equipmentUpdate, profileSchema, harvestSchema };
