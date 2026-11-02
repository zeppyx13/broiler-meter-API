const fs = require("fs");
const path = require("path");
const model = require("../models/schemaCompatibility.model");

const normalizeType = (type) => type.toLowerCase().replace(/\b(tinyint|smallint|int|bigint)\(\d+\)/g, "$1");
const normalizeDefault = (value) => {
  if (value == null || value === "NULL") return null;
  return String(value).replace(/^'(.*)'$/, "$1").toLowerCase().replace(/\(\)$/, "");
};

async function verify(connection) {
  const schema = fs.readFileSync(path.join(__dirname, "../../COASTHER_BROILER_SCHEMA_V1.sql"), "utf8");
  const actual = await model.metadata(connection);
  const differences = [];
  if (actual.selected.database_name !== "coasther_broiler") {
    throw new Error("DB_NAME must select coasther_broiler; no schema was modified");
  }
  const expectedTables = [...schema.matchAll(/CREATE TABLE `([^`]+)` \(([\s\S]*?)\) ENGINE/g)];
  let columnCount = 0;
  for (const [, table, body] of expectedTables) {
    if (actual.tables.find((item) => item.TABLE_NAME === table)?.ENGINE !== "InnoDB") {
      differences.push(`${table}: missing table or non-InnoDB engine`);
    }
    for (const [, name, definition] of body.matchAll(/^  `([^`]+)` ([^\r\n]+)/gm)) {
      columnCount++;
      const column = actual.columns.find((item) => item.TABLE_NAME === table && item.COLUMN_NAME === name);
      const type = definition.match(/^(\w+(?:\([^)]*\))?(?: UNSIGNED)?)/i)[1];
      const defaultValue = definition.match(/\bDEFAULT ('[^']*'|[^\s,]+)/i)?.[1] ?? null;
      if (!column || normalizeType(column.COLUMN_TYPE) !== normalizeType(type)
        || column.IS_NULLABLE !== (definition.includes("NOT NULL") ? "NO" : "YES")
        || normalizeDefault(column.COLUMN_DEFAULT) !== normalizeDefault(defaultValue)
        || /AUTO_INCREMENT/i.test(column.EXTRA) !== /AUTO_INCREMENT/i.test(definition)) {
        differences.push(`${table}.${name}: missing or incompatible column definition`);
      }
    }
    for (const [, kind, named, fields] of body.matchAll(/(?:^|\n)  (PRIMARY KEY|UNIQUE KEY|KEY)(?: `([^`]+)`)? \(([^)]+)\)/g)) {
      const name = kind === "PRIMARY KEY" ? "PRIMARY" : named;
      const index = actual.indexes.filter((item) => item.TABLE_NAME === table && item.INDEX_NAME === name);
      const names = [...fields.matchAll(/`([^`]+)`/g)].map((item) => item[1]);
      if (index.map((item) => item.COLUMN_NAME).join(",") !== names.join(",")
        || Boolean(index[0]?.NON_UNIQUE) !== (kind === "KEY")) {
        differences.push(`${table}.${name}: missing or incompatible index`);
      }
    }
  }
  // Includes the ALTER TABLE users/default_coop_id foreign key as well.
  for (const [, name, column, target, targetColumn, update, deletion] of schema.matchAll(
    /CONSTRAINT `([^`]+)` FOREIGN KEY \(`([^`]+)`\) REFERENCES `([^`]+)` \(`([^`]+)`\)\s+ON UPDATE (CASCADE|RESTRICT|SET NULL) ON DELETE (CASCADE|RESTRICT|SET NULL)/g,
  )) {
    const key = actual.foreignKeys.find((item) => item.CONSTRAINT_NAME === name);
    if (!key || key.COLUMN_NAME !== column || key.REFERENCED_TABLE_NAME !== target
      || key.REFERENCED_COLUMN_NAME !== targetColumn || key.UPDATE_RULE !== update || key.DELETE_RULE !== deletion) {
      differences.push(`${name}: missing or incompatible foreign key`);
    }
  }
  if (differences.length) {
    throw new Error(`Imported schema differs from approved SQL: ${differences.join("; ")}. No schema was modified.`);
  }
  return {
    database: actual.selected.database_name,
    version: actual.selected.version,
    verified_tables: expectedTables.length,
    verified_columns: columnCount,
    differences,
  };
}

module.exports = { verify };
