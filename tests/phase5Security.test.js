const {test}=require("node:test");
const assert=require("node:assert/strict");
const logMiddleware=require("../src/middlewares/requestLogger.middleware");
const logger=require("../src/config/logger");
const definitions=require("../src/utils/schemaDefinition");
const conversations=require("../src/models/copilotBroiler.model");
const accessModel=require("../src/models/access.model");
const db=require("../src/config/db");
test("authorization pool reads avoid joined shared locks while transactions keep current reads",async(t)=>{
 let pooledSql,transactionSql;
 t.mock.method(db,"query",async(sql)=>{pooledSql=sql;return [[{id:1}]];});
 await accessModel.coopForUser(7,1);
 await accessModel.coopForUser(7,1,{query:async(sql)=>{transactionSql=sql;return [[{id:1}]];}});
 assert.equal(pooledSql.includes("LOCK IN SHARE MODE"),false);
 assert.equal(transactionSql.includes("LOCK IN SHARE MODE"),true);
});
test("request logger records route templates and never query values or path parameters",(t)=>{
 const logs=[];t.mock.method(logger,"info",(value)=>logs.push(value));
 const req={method:"GET",originalUrl:"/api/coops/private-value?token=secret&message=private",baseUrl:"/api",route:{path:"/coops/:id"}};
 let finish;logMiddleware(req,{statusCode:200,on:(event,handler)=>{assert.equal(event,"finish");finish=handler;}},()=>{});finish();
 assert.match(logs[0],/^GET \/api\/coops\/:id 200/);assert.equal(/secret|private|token|message/.test(logs[0]),false);
 assert.equal(logMiddleware.safeRoute({originalUrl:"/api/private-key"}),"[unmatched route]");
});
test("schema extension comparison detects changed types defaults nullability indexes and FK actions",()=>{
 const sql="CREATE TABLE IF NOT EXISTS example (\n id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,\n value DECIMAL(12,3) DEFAULT NULL,\n flag TINYINT(1) NOT NULL DEFAULT 0,\n UNIQUE KEY uq_value (value,flag),\n CONSTRAINT fk_example FOREIGN KEY (id) REFERENCES parent(id) ON DELETE RESTRICT\n) ENGINE=InnoDB;";
 const tables=definitions.parseTables(sql),foreignKeys=definitions.parseForeignKeys(sql);
 const actual={tables:[{TABLE_NAME:"example",ENGINE:"InnoDB"}],columns:[{TABLE_NAME:"example",COLUMN_NAME:"id",COLUMN_TYPE:"bigint(20) unsigned",IS_NULLABLE:"NO",COLUMN_DEFAULT:null,EXTRA:"auto_increment"},{TABLE_NAME:"example",COLUMN_NAME:"value",COLUMN_TYPE:"decimal(12,3)",IS_NULLABLE:"YES",COLUMN_DEFAULT:"NULL",EXTRA:""},{TABLE_NAME:"example",COLUMN_NAME:"flag",COLUMN_TYPE:"tinyint(1)",IS_NULLABLE:"NO",COLUMN_DEFAULT:"0",EXTRA:""}],indexes:[{TABLE_NAME:"example",INDEX_NAME:"PRIMARY",COLUMN_NAME:"id",NON_UNIQUE:0,SEQ_IN_INDEX:1},{TABLE_NAME:"example",INDEX_NAME:"uq_value",COLUMN_NAME:"value",NON_UNIQUE:0,SEQ_IN_INDEX:1},{TABLE_NAME:"example",INDEX_NAME:"uq_value",COLUMN_NAME:"flag",NON_UNIQUE:0,SEQ_IN_INDEX:2}],foreignKeys:[{CONSTRAINT_NAME:"fk_example",COLUMN_NAME:"id",REFERENCED_TABLE_NAME:"parent",REFERENCED_COLUMN_NAME:"id",UPDATE_RULE:"RESTRICT",DELETE_RULE:"RESTRICT"}]};
 assert.deepEqual(definitions.compareTables(tables,actual),[]);assert.deepEqual(definitions.compareForeignKeys(foreignKeys,actual),[]);
 for(const patch of[{COLUMN_TYPE:"int unsigned"},{IS_NULLABLE:"YES"},{COLUMN_DEFAULT:"1"}]){
  const changed=structuredClone(actual);Object.assign(changed.columns[0],patch);assert.ok(definitions.compareTables(tables,changed).length>0);
 }
 const badIndex=structuredClone(actual);badIndex.indexes[2].NON_UNIQUE=1;badIndex.indexes[1].SEQ_IN_INDEX=3;assert.ok(definitions.compareTables(tables,badIndex).length>0);
 const badFk=structuredClone(actual);badFk.foreignKeys[0].DELETE_RULE="CASCADE";assert.ok(definitions.compareForeignKeys(foreignKeys,badFk).length>0);
});
test("private conversation list returns source metadata without changing owner-scoped parameterization",async()=>{
 let observed;const connection={query:async(sql,params)=>{observed={sql,params};return [[{id:1,source:"simulation"}]];}};
 const result=await conversations.conversations(7,8,{limit:20,before_id:12},connection);
 assert.equal(result[0].source,"simulation");assert.deepEqual(observed.params,[7,8,12,12,20]);
 assert.match(observed.sql,/JSON_EXTRACT\(m.context_json, '\$\.source'\)/);assert.match(observed.sql,/c.user_id = \? AND c.coop_id = \?/);
});
