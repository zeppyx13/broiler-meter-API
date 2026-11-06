// Review-only by default. Never imported by application startup.
require("dotenv").config({ quiet: true });
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const db = require("../config/db");
const { tableAvailable } = require("../utils/phase5Schema");

function statements(sql) {
  const result = [];
  let current = "",
    quote = null,
    lineComment = false,
    blockComment = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i],
      next = sql[i + 1];
    if (lineComment) {
      if (c === "\n") lineComment = false;
      else continue;
    }
    if (blockComment) {
      if (c === "*" && next === "/") {
        blockComment = false;
        i++;
      }
      continue;
    }
    if (!quote && c === "-" && next === "-") {
      lineComment = true;
      i++;
      continue;
    }
    if (!quote && c === "/" && next === "*") {
      blockComment = true;
      i++;
      continue;
    }
    if (quote) {
      current += c;
      if (c === "\\") {
        current += next || "";
        i++;
      } else if (c === quote) {
        if (next === quote) {
          current += next;
          i++;
        } else quote = null;
      }
      continue;
    }
    if (["'", '"', "`"].includes(c)) {
      quote = c;
      current += c;
      continue;
    }
    if (c === ";") {
      if (current.trim()) result.push(current.trim());
      current = "";
    } else current += c;
  }
  if (quote || blockComment) throw new Error("Unterminated SQL string/comment");
  if (current.trim()) result.push(current.trim());
  return result;
}
function approval(database, args, env = process.env) {
  if (args.includes("--apply")) {
    if (
      env.NODE_ENV !== "test" ||
      !/^coasther_broiler_test_[a-z0-9_]+$/.test(database)
    )
      throw new Error(
        "--apply is restricted to explicitly isolated coasther_broiler_test_* databases with NODE_ENV=test",
      );
    return true;
  }
  if (args.includes("--apply-active")) {
    if (
      database !== "coasther_broiler" ||
      env.PHASE5_OPERATOR_APPROVED !== "yes"
    )
      throw new Error(
        "Active apply requires explicit operator approval via PHASE5_OPERATOR_APPROVED=yes and the coasther_broiler target",
      );
    const index = args.indexOf("--backup-file"),
      backup = index >= 0 ? args[index + 1] : null;
    if (!backup || !fs.existsSync(backup) || fs.statSync(backup).size === 0)
      throw new Error(
        "Active apply requires --backup-file pointing to an existing nonempty operator-created backup",
      );
    return true;
  }
  return false;
}
async function main(args = process.argv.slice(2)) {
  const allowed = new Set([
    "--apply",
    "--apply-active",
    "--backup-file",
    "--preflight",
  ]);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--backup-file") {
      i++;
      continue;
    }
    if (!allowed.has(args[i]))
      throw new Error("Unsupported migration argument");
  }
  if (args.includes("--apply") && args.includes("--apply-active"))
    throw new Error("Choose isolated apply or active apply, never both");
  const connection = await db.getConnection();
  try {
    const [[target]] = await connection.query(
      "SELECT DATABASE() AS database_name",
    );
    const database = target.database_name;
    const apply = approval(database, args);
    if (
      database !== "coasther_broiler" &&
      !/^coasther_broiler_test_[a-z0-9_]+$/.test(database)
    )
      throw new Error("Refusing a non-Broiler database target");
    const [[count]] = await connection.query(
      "SELECT COUNT(*) AS coops FROM coops",
    );
    const [oversize] = await connection.query(
      "SELECT farm_id,COUNT(*) AS coop_count FROM coops GROUP BY farm_id HAVING COUNT(*)>4",
    );
    console.log(
      JSON.stringify({
        mode: apply ? "apply" : "preflight_only",
        database_name: database,
        existing_coops: Number(count.coops),
        farms_over_limit: oversize,
        warning:
          "DDL implicitly commits on MariaDB. Restore strategy is retain additive tables and revert application, or operator restore from verified backup. Existing operator memberships require explicit coop assignments after migration.",
      }),
    );
    const dir = path.resolve(__dirname, "../../migrations");
    for (const name of fs
      .readdirSync(dir)
      .filter((name) => /^\d+_[a-z0-9_]+\.sql$/.test(name))
      .sort()) {
      const sql = fs.readFileSync(path.join(dir, name), "utf8"),
        checksum = crypto.createHash("sha256").update(sql).digest("hex");
      const version = name.replace(/\.sql$/, "");
      let previous = null;
      if (await tableAvailable(connection, "schema_migrations")) {
        const [[row]] = await connection.query(
          "SELECT checksum_sha256 FROM schema_migrations WHERE version=?",
          [version],
        );
        previous = row;
      }
      if (previous) {
        if (previous.checksum_sha256 !== checksum)
          throw new Error(`Migration checksum changed: ${version}`);
        console.log(JSON.stringify({ version, state: "already_applied" }));
        continue;
      }
      const queries = statements(sql);
      if (
        queries.some((query) => !/^CREATE TABLE IF NOT EXISTS\s/i.test(query))
      )
        throw new Error(
          "Only additive CREATE TABLE IF NOT EXISTS migrations are accepted by this runner",
        );
      console.log(
        JSON.stringify({
          version,
          state: apply ? "applying" : "pending",
          statements: queries.length,
          checksum_sha256: checksum,
        }),
      );
      if (apply) {
        for (const query of queries) await connection.query(query);
        await connection.query(
          "INSERT INTO schema_migrations (version,checksum_sha256) VALUES (?,?)",
          [version, checksum],
        );
        console.log(JSON.stringify({ version, state: "applied" }));
      }
    }
  } finally {
    connection.release();
  }
}
if (require.main === module)
  main()
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    })
    .finally(() => db.end());
module.exports = { statements, approval, main };
