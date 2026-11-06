const bcrypt = require("bcryptjs");
const { z } = require("zod");
const seedModel = require("../models/demoSeed.model");
const farmModel = require("../models/farm.model");
const coopModel = require("../models/coop.model");
const flockModel = require("../models/flockCycle.model");
const accessModel = require("../models/access.model");
const { localDate } = require("../utils/farmDate");

const credentials = z
  .object({
    email: z.string().email().max(190),
    password: z
      .string()
      .min(12)
      .max(72)
      .refine((value) => Buffer.byteLength(value, "utf8") <= 72),
  })
  .strict();

// Caller owns the transaction. Existing credentials, memberships and cycles are never reset.
async function seed(connection, options) {
  const { email, password } = credentials.parse(options);
  let admin = await seedModel.admin(email, connection);
  if (admin) {
    if (
      admin.role !== "admin" ||
      admin.name !== "COASTHER Demo Admin" ||
      !(await bcrypt.compare(password, admin.password_hash))
    ) {
      throw new Error(
        "Existing account is not the matching demo admin; refusing to modify or elevate it",
      );
    }
  } else {
    admin = {
      id: await seedModel.createAdmin(
        email,
        await bcrypt.hash(password, 10),
        connection,
      ),
    };
  }
  let farm = await seedModel.farm(admin.id, connection);
  if (!farm) {
    const id = await farmModel.create(
      admin.id,
      {
        name: "COASTHER Demo Farm",
        location_text: "Development competition demo",
        timezone: "Asia/Makassar",
        electricity_rate_idr_per_kwh: 1444.7,
        water_rate_idr_per_m3: 0,
      },
      connection,
    );
    await farmModel.addMember(id, admin.id, "owner", connection);
    farm = await accessModel.lockFarm(id, connection);
  }
  const owner = await farmModel.findMember(farm.id, admin.id, connection);
  if (owner?.role !== "owner" || !farm.is_active)
    throw new Error(
      "Demo farm has changed; refusing to repair or reactivate it automatically",
    );
  const coops = await coopModel.list(
    { id: admin.id, role: "admin" },
    { farm_id: farm.id, page: 1, limit: 100 },
    connection,
  );
  let coop = coops.find((item) => item.code === "DEMO-01");
  if (!coop) {
    const id = await coopModel.create(
      {
        farm_id: farm.id,
        code: "DEMO-01",
        name: "Demo Closed House",
        capacity_birds: 10000,
        description: "Demo management data; no sensor readings",
        status: "active",
      },
      connection,
    );
    coop = await accessModel.lockCoop(id, connection);
  }
  if (coop.status !== "active")
    throw new Error(
      "Demo coop is inactive; refusing to reactivate it automatically",
    );
  let cycle = await flockModel.active(coop.id, connection);
  if (!cycle) {
    const history = await flockModel.list(
      { coop_id: coop.id, limit: 1, offset: 0 },
      connection,
    );
    if (history.length)
      throw new Error(
        "Demo cycle has already ended; refusing to start or reset another automatically",
      );
    if (coop.capacity_birds != null && Number(coop.capacity_birds) < 1000)
      throw new Error("Demo coop capacity is below seed population");
    const id = await flockModel.create(
      {
        coop_id: coop.id,
        cycle_code: "DEMO-V1",
        placement_date: localDate(farm.timezone),
        initial_population: 1000,
        notes: "Demo flock; no live sensor data seeded",
      },
      connection,
    );
    cycle = { id };
  }
  const user = await require("../models/user.model").findById(
    admin.id,
    connection,
  );
  if (!user.default_coop_id)
    await accessModel.setDefaultCoop(admin.id, coop.id, connection);
  return {
    admin_id: admin.id,
    farm_id: farm.id,
    coop_id: coop.id,
    flock_cycle_id: cycle.id,
    sensor_readings_created: 0,
  };
}

module.exports = { seed };
