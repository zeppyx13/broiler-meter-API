const fs=require("node:fs");
const path=require("node:path");
const model=require("../models/schemaCompatibility.model");
const definitions=require("../utils/schemaDefinition");

async function verify(connection) {
  const schema=fs.readFileSync(path.join(__dirname,"../../COASTHER_BROILER_SCHEMA_V1.sql"),"utf8");
  const actual=await model.metadata(connection);
  const database=actual.selected.database_name;
  if(database!=="coasther_broiler" && !(process.env.NODE_ENV==="test" && database===process.env.BROILER_TEST_DATABASE && /^coasther_broiler_test_[a-z0-9_]+$/.test(database)))throw new Error("DB_NAME must select coasther_broiler; no schema was modified");
  const core=definitions.parseTables(schema);
  const differences=[...definitions.compareTables(core,actual),...definitions.compareForeignKeys(definitions.parseForeignKeys(schema),actual)];
  const directory=path.join(__dirname,"../../migrations");
  const extensionSql=fs.existsSync(directory)?fs.readdirSync(directory).filter((file)=>/^00[56].*\.sql$/.test(file)).sort().map((file)=>fs.readFileSync(path.join(directory,file),"utf8")).join("\n"):"";
  const extensions=definitions.parseTables(extensionSql);
  const installed=extensions.filter((table)=>actual.tables.some((row)=>row.TABLE_NAME===table.name));
  if(installed.length && installed.length!==extensions.length)differences.push("Phase 5 migration is incomplete; apply the full reviewed migration set before enabling extension features");
  if(installed.length===extensions.length && installed.length){
    differences.push(...definitions.compareTables(extensions,actual),...definitions.compareForeignKeys(definitions.parseForeignKeys(extensionSql),actual));
  }
  if(differences.length)throw new Error("Imported schema differs from approved SQL: "+differences.join("; ")+". No schema was modified.");
  return {database,version:actual.selected.version,verified_tables:core.length,verified_columns:core.reduce((sum,table)=>sum+table.columns.length,0),differences,phase5:{state:installed.length?"migrated":"migration_required",verified_tables:installed.length,expected_tables:extensions.length,verified_columns:installed.reduce((sum,table)=>sum+table.columns.length,0),verified_indexes:installed.reduce((sum,table)=>sum+table.indexes.length,0),verified_foreign_keys:installed.length===extensions.length?definitions.parseForeignKeys(extensionSql).length:0}};
}
module.exports={verify};
