require("dotenv").config();
const db = require("../config/db");
const { runUsageMonthly } = require("../jobs/usageMonthly.job");

(async () => {
  try {
    await db.query("SELECT 1");
    const month = process.argv[2] || "2026-01";
    const result = await runUsageMonthly(month);
    console.log("DONE:", result);
    process.exit(0);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
})();
