const db = require("../config/db");

async function metadata(connection = db) {
  const [[selected]] = await connection.query("SELECT DATABASE() AS database_name, VERSION() AS version");
  const [tables] = await connection.query(
    "SELECT TABLE_NAME, ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?",
    ["coasther_broiler"],
  );
  const [columns] = await connection.query(
    "SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ?",
    ["coasther_broiler"],
  );
  const [indexes] = await connection.query(
    "SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, COLUMN_NAME, SEQ_IN_INDEX FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX",
    ["coasther_broiler"],
  );
  const [foreignKeys] = await connection.query(
    `SELECT k.TABLE_NAME, k.CONSTRAINT_NAME, k.COLUMN_NAME, k.REFERENCED_TABLE_NAME,
      k.REFERENCED_COLUMN_NAME, r.UPDATE_RULE, r.DELETE_RULE
     FROM information_schema.KEY_COLUMN_USAGE k
     JOIN information_schema.REFERENTIAL_CONSTRAINTS r
       ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.TABLE_NAME = k.TABLE_NAME
       AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
     WHERE k.TABLE_SCHEMA = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL`,
    ["coasther_broiler"],
  );
  return { selected, tables, columns, indexes, foreignKeys };
}

module.exports = { metadata };
