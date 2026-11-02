require("dotenv").config({ quiet: true });
const db = require("../config/db");
const { verify } = require("../services/schemaCompatibility.service");
const withTransaction = require("../utils/transaction");
const { seed } = require("../services/demoSeed.service");

(async () => {
  if (process.env.NODE_ENV === "production") throw new Error("Demo seed is development-only");
  await verify();
  if (!process.argv.includes("--apply")) {
    console.log("Dry run: no records written. --apply creates/reuses a demo admin, owner membership, farm, coop and active flock. No sensor data.");
    console.log("Set DEMO_ADMIN_EMAIL and DEMO_ADMIN_PASSWORD (12-72 UTF-8 bytes) before applying. Existing account credentials and flock history will be preserved.");
    return;
  }
  if (!process.env.DEMO_ADMIN_EMAIL || !process.env.DEMO_ADMIN_PASSWORD) {
    throw new Error("DEMO_ADMIN_EMAIL and DEMO_ADMIN_PASSWORD are required; no default password is provided");
  }
  const result = await withTransaction((connection) => seed(connection, {
    email: process.env.DEMO_ADMIN_EMAIL, password: process.env.DEMO_ADMIN_PASSWORD,
  }));
  console.log(JSON.stringify(result, null, 2));
})().catch((error) => {
  // Validation errors can contain inputs; keep credential values out of the console.
  console.error(error.name === "ZodError" ? "Invalid demo credentials; check email and password requirements" : error.code || error.message);
  process.exitCode = 1;
}).finally(() => db.end());
