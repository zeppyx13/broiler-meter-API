require("dotenv").config();
const db = require("../config/db");
const { generateInvoicesForMonth } = require("../jobs/invoiceMonthly.job");

(async () => {
  await db.query("SELECT 1");
  const month = process.argv[2] || "2026-01";
  const result = await generateInvoicesForMonth(month);
  console.log("DONE:", result);
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
