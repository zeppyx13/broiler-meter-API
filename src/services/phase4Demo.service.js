const bcrypt = require("bcryptjs");
const { z } = require("zod");
const model = require("../models/phase4Demo.model");
const { localDate } = require("../utils/farmDate");
const { shiftDate } = require("./analyticsContext.service");
const { calendarBoundary } = require("./dailyMetrics.service");
const credentials = z
  .object({
    email: z.email().max(190),
    password: z
      .string()
      .min(12)
      .max(72)
      .refine((value) => Buffer.byteLength(value, "utf8") <= 72),
  })
  .strict();
const refuse = () => {
  throw new Error(
    "Dedicated simulation cohort changed; refusing to overwrite data, dates or pairing",
  );
};
function dataset(meters, today) {
  const rows = [];
  for (const meter of meters) {
    let counter = 0;
    rows.push({
      meter_id: meter.id,
      reading_value: 0,
      delta_value: 0,
      reading_status: "baseline",
      recorded_at: new Date(
        calendarBoundary(shiftDate(today, -4), "Asia/Makassar").getTime() +
          60000,
      ),
    });
    for (let index = 0; index < 4; index++) {
      const delta = meter.type === "water" ? 100 + 10 * index : 1 + 0.1 * index;
      counter = Number((counter + delta).toFixed(6));
      rows.push({
        meter_id: meter.id,
        reading_value: counter,
        delta_value: Number(delta.toFixed(6)),
        reading_status: "accepted",
        recorded_at: new Date(
          calendarBoundary(
            shiftDate(today, index - 4),
            "Asia/Makassar",
          ).getTime() +
            12 * 3600000,
        ),
      });
    }
  }
  return rows.sort(
    (a, b) => a.recorded_at - b.recorded_at || a.meter_id - b.meter_id,
  );
}
// Caller owns transaction and an account-scoped advisory lock. Existing data is verified, never repaired/reset.
async function seed(connection, input, { now = new Date() } = {}) {
  if (
    process.env.NODE_ENV === "production" ||
    process.env.DB_NAME !== "coasther_broiler"
  )
    throw new Error("Phase 4 simulation seed is development-only");
  const { email, password } = credentials.parse(input);
  const today = localDate("Asia/Makassar", now);
  let admin = await model.account(email, connection);
  if (
    admin &&
    (admin.name !== "COASTHER Phase 4 Simulation Admin" ||
      admin.role !== "admin" ||
      !(await bcrypt.compare(password, admin.password_hash)))
  )
    refuse();
  if (!admin)
    admin = {
      id: await model.createAccount(
        email,
        await bcrypt.hash(password, 10),
        connection,
      ),
      default_coop_id: null,
    };
  let farm = await model.farm(admin.id, connection);
  if (!farm) {
    if (admin.default_coop_id) refuse();
    await model.createFarm(admin.id, connection);
    farm = await model.farm(admin.id, connection);
  }
  if (
    !farm.is_active ||
    farm.timezone !== "Asia/Makassar" ||
    Number(farm.electricity_rate_idr_per_kwh) !== 1500 ||
    Number(farm.water_rate_idr_per_m3) !== 2000
  )
    refuse();
  let tree = await model.tree(farm.id, connection);
  let ids;
  let created = false;
  if (!tree) {
    ids = await model.createTree(
      farm.id,
      admin.id,
      shiftDate(today, -5),
      shiftDate(today, 29),
      connection,
    );
    for (const row of dataset(ids.meters, today))
      await model.insertReading(ids, row, connection);
    tree = await model.tree(farm.id, connection);
    created = true;
  }
  const cycle = tree.cycles[0];
  const device = tree.devices[0];
  if (
    tree.coop_count !== 1 ||
    tree.coop.code !== "PHASE4-SIM" ||
    tree.coop.status !== "active" ||
    tree.member?.role !== "owner" ||
    tree.cycles.length !== 1 ||
    cycle.status !== "active" ||
    cycle.placement_date !== shiftDate(today, -5) ||
    cycle.planned_harvest_date !== shiftDate(today, 29) ||
    cycle.initial_population !== 1000 ||
    cycle.current_population !== 1000 ||
    tree.devices.length !== 1 ||
    device.device_type !== "other" ||
    device.device_uid !== `phase4_sim_${admin.id}` ||
    device.mqtt_topic_key !== `phase4_sim_${admin.id}` ||
    device.last_seen_at != null ||
    !device.is_active ||
    tree.meters.length !== 2 ||
    !tree.meters.some((row) => row.type === "water" && row.unit === "liter") ||
    !tree.meters.some(
      (row) => row.type === "electricity" && row.unit === "kwh",
    ) ||
    tree.meters.some(
      (row) =>
        row.last_reading_at != null ||
        row.last_reading_value != null ||
        row.counter_epoch !== 0 ||
        row.channel !== "main" ||
        !row.is_active ||
        row.meter_uid !== `phase4_sim_${admin.id}_${row.type}`,
    )
  )
    refuse();
  if (admin.default_coop_id && Number(admin.default_coop_id) !== tree.coop.id)
    refuse();
  const expected = dataset(tree.meters, today);
  if (
    tree.readings.length !== expected.length ||
    tree.readings.some(
      (row, index) =>
        row.source !== "simulation" ||
        row.flock_cycle_id !== cycle.id ||
        row.meter_id !== expected[index].meter_id ||
        Number(row.reading_value) !== expected[index].reading_value ||
        Number(row.delta_value) !== expected[index].delta_value ||
        row.reading_status !== expected[index].reading_status ||
        new Date(row.recorded_at).getTime() !==
          expected[index].recorded_at.getTime(),
    )
  )
    refuse();
  await model.setDefault(admin.id, tree.coop.id, connection);
  return {
    source: "simulation",
    is_simulated: true,
    created,
    reused: !created,
    admin_id: admin.id,
    farm_id: farm.id,
    coop_id: tree.coop.id,
    flock_cycle_id: cycle.id,
    device_id: device.id,
    meter_ids: tree.meters.map((row) => row.id),
    raw_simulation_rows: expected.length,
    closed_observation_days: 4,
    physical_cursor_updated: false,
    heartbeat_updated: false,
  };
}
module.exports = { seed, dataset };
