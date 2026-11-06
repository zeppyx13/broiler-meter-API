function normalizeType(type) {
  return String(type).toLowerCase().replace(/\b(tinyint|smallint|int|bigint)\(\d+\)/g,"$1");
}
function normalizeDefault(value) {
  if(value==null || value==="NULL")return null;
  return String(value).replace(/^'(.*)'$/,"$1").toLowerCase().replace(/\(\)$/," ").trim();
}
const names=(fields)=>[...fields.matchAll(/`?([a-z_][a-z0-9_]*)`?(?:\(\d+\))?/gi)].map((match)=>match[1]);
function parseTables(sql) {
  return [...sql.matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+`?([a-z_][a-z0-9_]*)`?\s*\(([\s\S]*?)\) ENGINE/gi)].map(([,name,body])=>{
    const columns=[],indexes=[];
    for(const line of body.split(/\r?\n/)){
      const match=line.trim().match(/^`?([a-z_][a-z0-9_]*)`?\s+((?:BIGINT|INT|TINYINT|SMALLINT|VARCHAR|CHAR|TEXT|LONGTEXT|DECIMAL|DOUBLE|DATETIME|DATE|TIMESTAMP|JSON|ENUM)(?:\([^)]*\))?(?: UNSIGNED)?)([\s\S]*)/i);
      if(match){
        const [,column,type,rest]=match,defaultValue=rest.match(/\bDEFAULT\s+('(?:''|[^'])*'|[^\s,]+)/i)?.[1]??null;
        columns.push({name:column,type,nullable:!/NOT NULL|PRIMARY KEY/i.test(rest),defaultValue,autoIncrement:/AUTO_INCREMENT/i.test(rest),onUpdate:/ON UPDATE CURRENT_TIMESTAMP/i.test(rest)});
        if(/PRIMARY KEY/i.test(rest))indexes.push({name:"PRIMARY",columns:[column],unique:true});
      }
    }
    for(const [,kind,index,fields]of body.matchAll(/(?:^|\n)\s*(PRIMARY KEY|UNIQUE KEY|KEY)(?:\s+`?([a-z_][a-z0-9_]*)`?)?\s*\(([^)]+)\)/gi))indexes.push({name:kind.toUpperCase()==="PRIMARY KEY"?"PRIMARY":index,columns:names(fields),unique:kind.toUpperCase()!=="KEY"});
    return {name,columns,indexes};
  });
}
function parseForeignKeys(sql) {
  return [...sql.matchAll(/CONSTRAINT\s+`?([a-z_][a-z0-9_]*)`?\s+FOREIGN KEY\s*\(\s*`?([a-z_][a-z0-9_]*)`?\s*\)\s+REFERENCES\s+`?([a-z_][a-z0-9_]*)`?\s*\(\s*`?([a-z_][a-z0-9_]*)`?\s*\)(?:\s+ON UPDATE\s+(CASCADE|RESTRICT|SET NULL))?(?:\s+ON DELETE\s+(CASCADE|RESTRICT|SET NULL))?/gi)].map(([,name,column,target,targetColumn,update,deletion])=>({name,column,target,targetColumn,update:(update||"RESTRICT").toUpperCase(),deletion:(deletion||"RESTRICT").toUpperCase()}));
}
function compareTables(expected,actual) {
  const differences=[];
  for(const table of expected){
    if(actual.tables.find((row)=>row.TABLE_NAME===table.name)?.ENGINE!=="InnoDB")differences.push(`${table.name}: missing table or non-InnoDB engine`);
    for(const definition of table.columns){
      const column=actual.columns.find((row)=>row.TABLE_NAME===table.name&&row.COLUMN_NAME===definition.name);
      if(!column || normalizeType(column.COLUMN_TYPE)!==normalizeType(definition.type) || column.IS_NULLABLE!==(definition.nullable?"YES":"NO") || normalizeDefault(column.COLUMN_DEFAULT)!==normalizeDefault(definition.defaultValue) || /AUTO_INCREMENT/i.test(column.EXTRA)!==definition.autoIncrement || /ON UPDATE CURRENT_TIMESTAMP/i.test(column.EXTRA)!==definition.onUpdate)differences.push(`${table.name}.${definition.name}: missing or incompatible column definition`);
    }
    for(const definition of table.indexes){
      const index=actual.indexes.filter((row)=>row.TABLE_NAME===table.name&&row.INDEX_NAME===definition.name).sort((a,b)=>a.SEQ_IN_INDEX-b.SEQ_IN_INDEX);
      if(index.map((row)=>row.COLUMN_NAME).join(",")!==definition.columns.join(",") || Boolean(index[0]?.NON_UNIQUE)===definition.unique)differences.push(`${table.name}.${definition.name}: missing or incompatible index`);
    }
  }
  return differences;
}
function compareForeignKeys(expected,actual) {
  return expected.filter((definition)=>{
    const key=actual.foreignKeys.find((row)=>row.CONSTRAINT_NAME===definition.name);
    return !key || key.COLUMN_NAME!==definition.column || key.REFERENCED_TABLE_NAME!==definition.target || key.REFERENCED_COLUMN_NAME!==definition.targetColumn || key.UPDATE_RULE!==definition.update || key.DELETE_RULE!==definition.deletion;
  }).map((definition)=>`${definition.name}: missing or incompatible foreign key`);
}
module.exports={normalizeType,normalizeDefault,parseTables,parseForeignKeys,compareTables,compareForeignKeys};
