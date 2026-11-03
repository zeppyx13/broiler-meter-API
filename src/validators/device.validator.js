const { z } = require("zod");
const { id, idParam, listQuery } = require("./farm.validator");

// One literal MQTT topic segment: no slash, wildcard, whitespace or control characters.
const topicIdentity = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const fields = {
  name: z.string().trim().min(1).max(120),
  device_type: z.enum(["esp32", "gateway", "other"]),
  firmware_version: z.string().trim().max(60).nullable(),
  is_active: z.boolean(),
};
const createSchema = z
  .object({
    coop_id: id,
    device_uid: topicIdentity,
    mqtt_topic_key: topicIdentity,
    ...fields,
    device_type: fields.device_type.default("esp32"),
    firmware_version: fields.firmware_version.default(null),
    is_active: fields.is_active.default(true),
  })
  .strict();
// Pairing identities never move: buffered messages must keep their original attribution.
const updateSchema = z
  .object(fields)
  .partial()
  .strict()
  .refine(
    (value) => Object.keys(value).length > 0,
    "Provide at least one field",
  );
const activeFilter = z.enum(["0", "1"]).transform(Number);
const querySchema = listQuery
  .extend({ coop_id: id.optional(), is_active: activeFilter.optional() })
  .strict();

module.exports = {
  idParam,
  topicIdentity,
  activeFilter,
  createSchema,
  updateSchema,
  querySchema,
};
