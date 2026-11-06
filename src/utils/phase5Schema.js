const db = require("../config/db");
const httpError = require("./httpError");

async function tableAvailable(connection = db, table) {
  const [[row]] = await connection.query(
    "SELECT COUNT(*) AS present FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?",
    [table],
  );
  return Number(row.present) === 1;
}

function migrationError() {
  const error = httpError(503, "migration_required: apply the reviewed Phase 5 migration before using this feature");
  error.code = "migration_required";
  return error;
}

async function requireTables(connection = db, tables = []) {
  for (const table of tables) if (!(await tableAvailable(connection, table))) throw migrationError();
}

module.exports = { tableAvailable, requireTables, migrationError };
