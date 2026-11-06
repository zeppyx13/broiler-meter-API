const {test}=require("node:test");
const assert=require("node:assert/strict");
const crypto=require("node:crypto");
const v=require("../src/validators/phase5Domain.validator");
const service=require("../src/services/phase5Domain.service");
const access=require("../src/services/access.service");
const accessModel=require("../src/models/access.model");
const model=require("../src/models/phase5Domain.model");
const schema=require("../src/utils/phase5Schema");
const db=require("../src/config/db");
const flock=require("../src/services/flockCycle.service");
const flockModel=require("../src/models/flockCycle.model");
const {statements,approval}=require("../src/scripts/migrate_phase5");

test("daily record validators reject unknown fields, signs, invalid dates and stale-version shapes",()=>{
 assert.equal(v.recordSchema.safeParse({dead:-1,culled:0}).success,false);
 assert.equal(v.recordSchema.safeParse({dead:1,culled:0,role:"admin"}).success,false);
 assert.equal(v.dailyParam.safeParse({id:1,date:"2026-02-30"}).success,false);
 assert.equal(v.recordSchema.safeParse({dead:0,culled:0,feed_kg:0,avg_weight_g:null,request_id:crypto.randomUUID(),expected_revision:0}).success,true);
 assert.equal(v.voidSchema.safeParse({expected_revision:1,note:"too"}).success,false);
});
test("daily correction uses signed ledger deltas and preserves original events",()=>{
 const result=service.populationCorrections({dead:4,culled:1},{dead:2,culled:3},"2026-11-05");
 assert.deepEqual(result.map((row)=>[row.event_type,row.population_change,row.category]),[["adjustment",2,"mortality"],["culling",-2,"culling"]]);
 assert.deepEqual(service.populationCorrections({dead:2,culled:3},{dead:2,culled:3},"2026-11-05"),[]);
});
test("historical daily correction rejects intermediate negative population even if final recovers",()=>{
 assert.throws(()=>service.checkTimeline(10,[{delta:-11},{delta:5}],20),{statusCode:409});
 assert.throws(()=>service.checkTimeline(10,[{delta:11},{delta:-5}],20),{statusCode:409});
 assert.equal(service.checkTimeline(10,[{delta:-2},{delta:1}],20),9);
});
test("profile updates authorize the locked cycle status after concurrent completion",async(t)=>{
 const order=[];
 const connection={beginTransaction:async()=>{},commit:async()=>{},rollback:async()=>order.push("rollback"),release:()=>{}};
 t.mock.method(db,"getConnection",async()=>connection);
 t.mock.method(flock,"get",async()=>({id:3,coop_id:7,status:"active"}));
 t.mock.method(schema,"requireTables",async()=>{});
 t.mock.method(access,"lockCoop",async()=>order.push("parents"));
 t.mock.method(flockModel,"lockById",async()=>{order.push("cycle");return{id:3,coop_id:7,status:"completed"};});
 t.mock.method(access,"requireCoop",async(user,id,capability)=>{order.push(capability);throw Object.assign(Error("Farm access denied"),{statusCode:403});});
 t.mock.method(model,"saveCycleProfile",async()=>{throw Error("must not update");});
 await assert.rejects(service.profile({id:1,role:"operator"},3,{harvest_target_days:35}),{statusCode:403});
 assert.deepEqual(order,["parents","cycle","manage","rollback"]);
});
test("FCR and IP remain null without complete feed coverage or weight",()=>{
 const cycle={initial_population:100,current_population:98,status:"completed",placement_date:"2026-11-01",actual_harvest_date:"2026-11-03",timezone:"Asia/Makassar"};
 const partial=[{date:"2026-11-03",dead:2,culled:0,feed_kg:10,avg_weight_g:1000,is_void:false}];
 assert.equal(service.performance(cycle,partial,[]).fcr,null);
 const full=[{date:"2026-11-01",dead:0,culled:0,feed_kg:10,is_void:false},{date:"2026-11-02",dead:1,culled:0,feed_kg:10,is_void:false},{date:"2026-11-03",dead:1,culled:0,feed_kg:10,avg_weight_g:1000,is_void:false}];
 const result=service.performance(cycle,full,[]);assert.equal(result.fcr,30/98);assert.equal(result.survival_pct,98);assert.ok(result.performance_index>0);
 assert.equal(service.performance(cycle,full.map((row)=>({...row,avg_weight_g:null})),[]).performance_index,null);
});
test("coop assignment is deny-by-default after migration and relay permission is granular",async(t)=>{
 t.mock.method(accessModel,"coopForUser",async()=>({id:7,member_role:"operator",farm_is_active:1,status:"active"}));
 t.mock.method(schema,"tableAvailable",async()=>true);
 t.mock.method(model,"assignment",async()=>null);
 await assert.rejects(access.requireCoop({id:1,role:"operator"},7),{statusCode:403});
 t.mock.method(model,"assignment",async()=>({can_operate:1,relay_operate:0}));
 await access.requireCoop({id:1,role:"operator"},7,"operate");
 await assert.rejects(access.requireCoop({id:1,role:"operator"},7,"relay:operate"),{statusCode:403});
 t.mock.method(model,"assignment",async()=>({can_operate:1,relay_operate:1}));
 await access.requireCoop({id:1,role:"operator"},7,"relay:operate");
});
test("V1 permissions stay compatible until migration but operator relay remains denied",async(t)=>{
 t.mock.method(accessModel,"coopForUser",async()=>({id:7,member_role:"operator",farm_is_active:1,status:"active"}));
 t.mock.method(schema,"tableAvailable",async()=>false);
 await access.requireCoop({id:1,role:"operator"},7,"operate");
 await assert.rejects(access.requireCoop({id:1,role:"operator"},7,"relay:operate"),{statusCode:403});
});
test("viewer never acquires operate/manage/relay capability from a spoofed request",async(t)=>{
 t.mock.method(accessModel,"coopForUser",async()=>({id:7,member_role:"viewer",farm_is_active:1,status:"active"}));
 for(const capability of ["operate","manage","relay:operate"])await assert.rejects(access.requireCoop({id:1,role:"operator"},7,capability),{statusCode:403});
});
test("equipment and assignment contracts reject arbitrary capabilities and unknown fields",()=>{
 assert.equal(v.assignmentSchema.safeParse({user_id:1,can_operate:false,relay_operate:true}).success,false);
 assert.equal(v.equipmentCreate.safeParse({name:"Fan",type:"fan",count:1,rated_watt:45}).success,true);
 assert.equal(v.equipmentCreate.safeParse({name:"Fan",type:"fan",count:1,rated_watt:45,reported_state:"on"}).success,false);
 assert.equal(v.equipmentCreate.safeParse({name:"Fan",type:"fan",count:1,rated_watt:45,schedule:{start:"25:00",end:"08:00"}}).success,false);
 assert.equal(v.profileSchema.safeParse({strain:"Cobb",harvest_target_days:35}).success,true);
});
test("harvest contract requires UUID and rejects raw commands",()=>{
 assert.equal(v.harvestSchema.safeParse({harvested_count:2,actual_harvest_date:"2026-11-06",request_id:crypto.randomUUID()}).success,true);
 assert.equal(v.harvestSchema.safeParse({harvested_count:2,actual_harvest_date:"2026-11-06",command:"reset_nvs"}).success,false);
});
test("migration parser preserves semicolons in quoted data and refuses active mutation by default",()=>{
 assert.deepEqual(statements("-- comment\nCREATE TABLE IF NOT EXISTS example (value VARCHAR(20) DEFAULT 'a;b'); /* comment */"),["CREATE TABLE IF NOT EXISTS example (value VARCHAR(20) DEFAULT 'a;b')"]);
 assert.equal(approval("coasther_broiler",[]),false);
 assert.throws(()=>approval("coasther_broiler",["--apply"],{NODE_ENV:"test"}),/restricted/);
 assert.equal(approval("coasther_broiler_test_fixture",["--apply"],{NODE_ENV:"test"}),true);
 assert.throws(()=>approval("coasther_broiler",["--apply-active"],{}),/operator approval/);
});
