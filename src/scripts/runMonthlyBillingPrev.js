require("dotenv").config();

const { spawn } = require("child_process");

function getPrevMonthYYYYMM() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const prev = new Date(Date.UTC(y, m - 1, 1));
  const yy = prev.getUTCFullYear();
  const mm = String(prev.getUTCMonth() + 1).padStart(2, "0");
  return `${yy}-${mm}`;
}

const month = process.argv[2] || getPrevMonthYYYYMM();

const child = spawn(
  process.execPath,
  ["src/scripts/runMonthlyBilling.js", month],
  { stdio: "inherit" },
);

child.on("exit", (code) => process.exit(code));
