// Creates empty, namespaced test schemas. Never imports or modifies active data.
require("dotenv").config({ quiet: true });
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const mysql = require("mysql2/promise");
const { statements } = require("./migrate_phase5");
const { spawnSync } = require("node:child_process");
const db = require("../config/db");
const root = path.resolve(__dirname, "../..");
async function snapshot(connection) {
  const [tables] = await connection.query("SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=? ORDER BY TABLE_NAME", ["coasther_broiler"]);
  const counts = {};
  for (const row of tables) {
    if (!/^[a-z_]+$/.test(row.TABLE_NAME)) throw new Error("Unexpected table identifier");
    const [[count]] = await connection.query(`SELECT COUNT(*) AS count FROM coasther_broiler.\`${row.TABLE_NAME}\``);
    counts[row.TABLE_NAME] = Number(count.count);
  }
  const [sources] = await connection.query("SELECT source,COUNT(*) AS count FROM coasther_broiler.meter_readings GROUP BY source");
  return { at: new Date().toISOString(), tables: counts, meter_readings_by_source: sources };
}
async function create(connection, name) {
  if (!/^coasther_broiler_test_[a-z0-9_]+$/.test(name)) throw new Error("Unsafe isolated schema name");
  const [[exists]] = await connection.query("SELECT COUNT(*) AS count FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME=?", [name]);
  if (Number(exists.count)) throw new Error("Isolated schema already exists; refusing to reset/reuse it");
  await connection.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  const isolated = await mysql.createConnection({ host: process.env.DB_HOST, port: process.env.DB_PORT, user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: name });
  try {
    const sql = fs.readFileSync(path.join(root, "COASTHER_BROILER_SCHEMA_V1.sql"), "utf8");
    for (const statement of statements(sql)) {
      if (/^(CREATE DATABASE|USE\s)/i.test(statement)) continue;
      if (/\bcoasther_broiler\s*\./i.test(statement)) throw new Error("Schema contains active database qualification");
      await isolated.query(statement);
    }
  } finally { await isolated.end(); }
}
function run(args, database) {
  const result = spawnSync(process.execPath, args, { cwd: root, env: { ...process.env, NODE_ENV: "test", DB_NAME: "coasther_broiler", BROILER_TEST_DATABASE: database, BROILER_MQTT_ENABLED: "false", BROILER_EMAIL_ENABLED: "false" }, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  process.stdout.write(result.stdout || ""); process.stderr.write(result.stderr || "");
  console.log(JSON.stringify({ command: ["node", ...args], database, exit: result.status }));
  return result.status ?? 1;
}
async function main() {
  const connection = await mysql.createConnection({ host: process.env.DB_HOST, port: process.env.DB_PORT, user: process.env.DB_USER, password: process.env.DB_PASSWORD });
  const suffix = `${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
  const base = `coasther_broiler_test_${suffix}`;
  const evidence = { before: await snapshot(connection), databases: { v1: `${base}_v1`, phase5: `${base}_p5` }, runs: [] };
  try {
    await create(connection, evidence.databases.v1);
    await create(connection, evidence.databases.phase5);
    const dir = path.join(root, "docs/audit/result"); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "phase5-isolated-targets.json"), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ created_isolated_schemas: evidence.databases, active_schema_modified: false }));
    if (process.argv.includes("--run")) {
      const suites = ["broiler.integration.js", "iotBroiler.integration.js", "guard.integration.js", "notificationBroiler.integration.js", "relayBroiler.integration.js", "forecast.integration.js", "ecoAdvisor.integration.js", "copilotBroiler.integration.js", "phase4Demo.integration.js", "dailyMetricsLock.integration.js"];
      for (const suite of suites) evidence.runs.push({ suite, exit: run(["--test", `tests/${suite}`], evidence.databases.v1) });
      evidence.runs.push({ suite: "migration first apply", exit: run(["src/scripts/migrate_phase5.js", "--apply"], evidence.databases.phase5) });
      evidence.runs.push({ suite: "migration repeat", exit: run(["src/scripts/migrate_phase5.js", "--apply"], evidence.databases.phase5) });
      evidence.runs.push({ suite: "migrated schema verify", exit: run(["src/scripts/verify_broiler_db.js"], evidence.databases.phase5) });
      for (const suite of ["phase5Domain.integration.js", "phase5Monitoring.integration.js"]) if (fs.existsSync(path.join(root, "tests", suite))) evidence.runs.push({ suite, exit: run(["--test", `tests/${suite}`], evidence.databases.phase5) });
    }
    evidence.after = await snapshot(connection);
    fs.writeFileSync(path.join(dir, "phase5-isolated-targets.json"), JSON.stringify(evidence, null, 2));
    if (evidence.runs.some(item => item.exit)) process.exitCode = 1;
  } finally { await connection.end(); await db.end(); }
}
main().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
