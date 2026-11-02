require("dotenv").config();

const fs = require("fs");
const path = require("path");

const db = require("../config/db");
const { runUsageMonthly } = require("../jobs/usageMonthly.job");
const { generateInvoicesForMonth } = require("../jobs/invoiceMonthly.job");

function assertYYYYMM(month) {
  if (!/^\d{4}-\d{2}$/.test(month)) {
    throw new Error("month must be in YYYY-MM format");
  }
  const [y, m] = month.split("-").map(Number);
  if (m < 1 || m > 12) throw new Error("Invalid month");
  return { y, m };
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function logLine(message) {
  const logDir = path.join(process.cwd(), "logs");
  ensureDir(logDir);
  const logFile = path.join(logDir, "billing.log");
  const line = `[${new Date().toISOString()}] ${message}\n`;
  fs.appendFileSync(logFile, line);
  console.log(message);
}

async function withDbConnection(fn) {
  await db.query("SELECT 1");
  return fn();
}

async function main() {
  const month = process.argv[2];
  if (!month) {
    throw new Error("Usage: node src/scripts/runMonthlyBilling.js YYYY-MM");
  }
  assertYYYYMM(month);

  logLine(`START monthly billing month=${month}`);

  await withDbConnection(async () => {
    // 1) compute usage
    const usageRes = await runUsageMonthly(month);
    logLine(`USAGE done: ${JSON.stringify(usageRes)}`);

    // 2) generate invoices
    const invRes = await generateInvoicesForMonth(month);
    logLine(`INVOICES done: ${JSON.stringify(invRes)}`);
  });

  logLine(`DONE monthly billing month=${month}`);
  process.exit(0);
}

main().catch((err) => {
  logLine(`ERROR: ${err.message}`);
  process.exit(1);
});
