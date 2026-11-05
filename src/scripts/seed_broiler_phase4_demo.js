require("dotenv").config({ quiet: true });
const crypto = require("node:crypto");
const db = require("../config/db");
const { verify } = require("../services/schemaCompatibility.service");
const { seed } = require("../services/phase4Demo.service");
const model = require("../models/phase4Demo.model");
(async () => {
  if (process.env.NODE_ENV === "production")
    throw new Error("Development only");
  await verify();
  if (!process.argv.includes("--apply")) {
    console.log(
      "Dry run: no records written. --apply creates a dedicated SIMULATION admin/farm/coop/cycle/device/meters and four closed days, separate from real pairing.",
    );
    console.log(
      "Set DEMO_PHASE4_EMAIL/PASSWORD (12-72 UTF8 bytes). Existing cohort data is verified, never reset; a different calendar window is refused.",
    );
    return;
  }
  if (!process.env.DEMO_PHASE4_EMAIL || !process.env.DEMO_PHASE4_PASSWORD)
    throw new Error("Demo credentials required");
  const connection = await db.getConnection();
  const lock = `phase4-demo:${crypto.createHash("sha256").update(process.env.DEMO_PHASE4_EMAIL).digest("hex").slice(0, 40)}`;
  let acquired = false;
  try {
    acquired = await model.acquire(lock, connection);
    if (!acquired) throw new Error("Demo seed is already running");
    await connection.beginTransaction();
    const result = await seed(connection, {
      email: process.env.DEMO_PHASE4_EMAIL,
      password: process.env.DEMO_PHASE4_PASSWORD,
    });
    await connection.commit();
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    try {
      if (acquired) await model.release(lock, connection);
      connection.release();
    } catch {
      connection.destroy();
    }
  }
})()
  .catch(() => {
    console.error(
      "Phase 4 demo not applied: check dedicated credentials, cohort identity and local dates. Private details omitted.",
    );
    process.exitCode = 1;
  })
  .finally(() => db.end());
