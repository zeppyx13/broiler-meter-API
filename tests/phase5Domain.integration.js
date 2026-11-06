require("dotenv").config({quiet:true});
const {test}=require("node:test");
const assert=require("node:assert/strict");
const crypto=require("node:crypto");
if(process.env.NODE_ENV!=="test" || !/^coasther_broiler_test_[a-z0-9_]+$/.test(process.env.BROILER_TEST_DATABASE || ""))throw new Error("Phase 5 integration tests require an explicitly isolated migrated test database");
process.env.DB_NAME="coasther_broiler";
process.env.JWT_SECRET ||= crypto.randomBytes(32).toString("hex");
const jwt=require("jsonwebtoken");
const db=require("../src/config/db");
const app=require("../src/app");
const domain=require("../src/services/phase5Domain.service");
const farmService=require("../src/services/farm.service");
const coopService=require("../src/services/coop.service");
const flockService=require("../src/services/flockCycle.service");
const devices=require("../src/services/device.service");
const meters=require("../src/services/meterBroiler.service");
const ingestion=require("../src/services/iotBroiler.service");
const {localDate}=require("../src/utils/farmDate");
const schema=require("../src/utils/phase5Schema");

test("Phase 5 domain migrated HTTP and transactional integration",{timeout:120000},async(t)=>{
 const [[target]]=await db.query("SELECT DATABASE() AS name");assert.equal(target.name,process.env.BROILER_TEST_DATABASE);
 await schema.requireTables(db,["coop_members","flock_daily_records","flock_daily_record_revisions","flock_harvest_requests"]);
 const marker=`phase5-domain-${crypto.randomUUID()}`,users=[],farms=[],coops=[],cycles=[];
 let server,base,owner,operator,viewer,outsider,farm,coop,otherCoop,cycle,device,water,energy;
 const today=localDate("Asia/Makassar"),placement=new Date(Date.parse(today)-2*86400000).toISOString().slice(0,10);
 async function user(label,role="operator"){
  const [r]=await db.query("INSERT INTO users (name,email,password_hash,role,is_verified) VALUES (?,?,?,?,1)",[`${marker}-${label}`,`${marker}-${label}@example.invalid`,crypto.randomBytes(32).toString("hex"),role]);
  users.push(r.insertId);return {id:r.insertId,role,token:jwt.sign({id:r.insertId,role},process.env.JWT_SECRET,{expiresIn:"5m"})};
 }
 async function request(method,path,actor,body,expected=200){
  const response=await fetch(base+path,{method,headers:{...(actor?{Authorization:`Bearer ${actor.token}`} : {}),...(body?{"Content-Type":"application/json"}:{})},...(body?{body:JSON.stringify(body)}:{})});
  const result=await response.json();assert.equal(response.status,expected,`${method} ${path}: ${JSON.stringify(result)}`);return result.data;
 }
 async function ids(table,field,values){if(!values.length)return [];const [r]=await db.query(`SELECT id FROM ${table} WHERE ${field} IN (?)`,[values]);return r.map((row)=>row.id);}
 async function remove(table,key,values){if(values.length)await db.query(`DELETE FROM ${table} WHERE ${key} IN (?)`,[values]);}
 async function cleanup(){
  const recordIds=await ids("flock_daily_records","flock_cycle_id",cycles),revisionIds=await ids("flock_daily_record_revisions","flock_cycle_id",cycles),eventIds=await ids("flock_events","flock_cycle_id",cycles);
  const deviceIds=await ids("devices","coop_id",coops),meterIds=await ids("meters","device_id",deviceIds),alertIds=await ids("alerts","coop_id",coops);
  await remove("notifications","id",await ids("notifications","alert_id",alertIds));
  await remove("flock_daily_record_events","event_id",eventIds);
  await remove("flock_daily_record_revisions","id",revisionIds);
  await remove("flock_daily_records","id",recordIds);
  await remove("flock_harvest_requests","id",await ids("flock_harvest_requests","flock_cycle_id",cycles));
  await remove("flock_cycle_profiles","flock_cycle_id",cycles);
  await remove("domain_audit_log","id",await ids("domain_audit_log","coop_id",coops));
  await remove("coop_equipment","id",await ids("coop_equipment","coop_id",coops));
  await remove("coop_members","id",await ids("coop_members","coop_id",coops));
  if(await schema.tableAvailable(db,"telemetry_samples"))await remove("telemetry_samples","id",await ids("telemetry_samples","coop_id",coops));
  await remove("meter_readings","id",await ids("meter_readings","coop_id",coops));
  await remove("daily_coop_metrics","id",await ids("daily_coop_metrics","flock_cycle_id",cycles));
  await remove("ai_cache","id",await ids("ai_cache","coop_id",coops));
  await remove("forecasts","id",await ids("forecasts","coop_id",coops));
  await remove("eco_recommendations","id",await ids("eco_recommendations","coop_id",coops));
  await remove("alerts","id",alertIds);
  await remove("flock_events","id",eventIds);
  await remove("flock_cycles","id",cycles);
  await remove("meters","id",meterIds);
  await remove("coop_live_status","coop_id",coops);
  await remove("devices","id",deviceIds);
  if(users.length)await db.query("UPDATE users SET default_coop_id=NULL WHERE id IN (?)",[users]);
  await remove("coops","id",coops);
  await remove("farm_members","id",await ids("farm_members","farm_id",farms));
  await remove("farms","id",farms);
  await remove("users","id",users);
 }
 try{
  server=app.listen(0,"127.0.0.1");await new Promise((resolve)=>server.once("listening",resolve));base=`http://127.0.0.1:${server.address().port}`;
  owner=await user("owner","manager");operator=await user("operator");viewer=await user("viewer");outsider=await user("outsider");
  farm=(await farmService.create(owner,{name:marker,timezone:"Asia/Makassar",location_text:null,electricity_rate_idr_per_kwh:1500,water_rate_idr_per_m3:2000})).farm;farms.push(farm.id);
  for(const [actor,role]of[[operator,"operator"],[viewer,"viewer"]])await db.query("INSERT INTO farm_members (farm_id,user_id,role) VALUES (?,?,?)",[farm.id,actor.id,role]);
  coop=(await coopService.create(owner,{farm_id:farm.id,code:"D1",name:marker,capacity_birds:100,description:null,status:"active"})).coop;coops.push(coop.id);
  otherCoop=(await coopService.create(owner,{farm_id:farm.id,code:"D2",name:marker,capacity_birds:100,description:null,status:"active"})).coop;coops.push(otherCoop.id);
  cycle=await flockService.create(owner,{coop_id:coop.id,cycle_code:marker,placement_date:placement,initial_population:100,planned_harvest_date:today});cycles.push(cycle.id);
  await t.test("HTTP auth and coop assignment are enforced including direct ID tampering",async()=>{
   await request("GET",`/api/coops/${coop.id}/equipment`,null,null,401);
   await request("GET",`/api/coops/${coop.id}/equipment`,outsider,null,403);
   await request("GET",`/api/coops/${coop.id}/capabilities`,operator,null,403);
   await request("PUT",`/api/coops/${coop.id}/assignments`,owner,{user_id:operator.id,can_operate:true,relay_operate:false});
   const cap=await request("GET",`/api/coops/${coop.id}/capabilities`,operator);assert.equal(cap.capabilities.operate,true);assert.equal(cap.capabilities['relay:operate'],false);
   await request("GET",`/api/coops/${otherCoop.id}/capabilities`,operator,null,403);
   const list=await request("GET","/api/coops",operator);assert.deepEqual(list.coops.map((row)=>row.id),[coop.id]);
   await request("PUT",`/api/coops/${coop.id}/assignments`,viewer,{user_id:operator.id,can_operate:true,relay_operate:true},403);
  });
  await t.test("daily PUT persists feed and weight and applies population changes once with conflict replay",async()=>{
   const body={dead:2,culled:1,feed_kg:10,avg_weight_g:1000,note:"Fixture daily record",request_id:crypto.randomUUID(),expected_revision:0};
   const first=await request("PUT",`/api/flock-cycles/${cycle.id}/daily-records/${placement}`,operator,body);assert.equal(first.cycle.current_population,97);assert.equal(first.record.revision,1);
   const replay=await request("PUT",`/api/flock-cycles/${cycle.id}/daily-records/${placement}`,operator,body);assert.equal(replay.reused,true);assert.equal(replay.cycle.current_population,97);
   await request("PUT",`/api/flock-cycles/${cycle.id}/daily-records/${placement}`,operator,{...body,dead:3},409);
   await request("PUT",`/api/flock-cycles/${cycle.id}/daily-records/${placement}`,operator,{...body,request_id:crypto.randomUUID()},409);
   const update=await request("PUT",`/api/flock-cycles/${cycle.id}/daily-records/${placement}`,operator,{...body,dead:1,culled:2,request_id:crypto.randomUUID(),expected_revision:1});assert.equal(update.record.revision,2);assert.equal(update.cycle.current_population,97);
   const records=await request("GET",`/api/flock-cycles/${cycle.id}/daily-records`,viewer);assert.equal(records.records[0].feed_kg,10);assert.equal(records.records[0].avg_weight_g,1000);
   const audit=await request("GET",`/api/flock-cycles/${cycle.id}/daily-records/${placement}/revisions`,owner);assert.equal(audit.revisions.length,2);
   await request("PUT",`/api/flock-cycles/${cycle.id}/daily-records/${placement}`,viewer,{...body,request_id:crypto.randomUUID()},403);
  });
  await t.test("concurrent daily revisions serialize and optimistic conflict prevents lost updates",async()=>{
   const bodies=[0,1].map((index)=>({dead:1+index,culled:2,feed_kg:10,request_id:crypto.randomUUID(),expected_revision:2}));
   const results=await Promise.all(bodies.map(async(body)=>{const r=await fetch(`${base}/api/flock-cycles/${cycle.id}/daily-records/${placement}`,{method:"PUT",headers:{Authorization:`Bearer ${operator.token}`,"Content-Type":"application/json"},body:JSON.stringify(body)});return r.status;}));
   assert.deepEqual(results.sort(),[200,409]);
  });
  await t.test("void retains audit ledger and restores counts with an explicit reason",async()=>{
   const records=await request("GET",`/api/flock-cycles/${cycle.id}/daily-records`,owner),revision=records.records[0].revision;
   const result=await request("DELETE",`/api/flock-cycles/${cycle.id}/daily-records/${placement}`,operator,{request_id:crypto.randomUUID(),expected_revision:revision,note:"Void mistaken fixture record"});assert.equal(result.cycle.current_population,100);assert.equal(result.record.is_void,true);
   const [[events]]=await db.query("SELECT COUNT(*) AS total FROM flock_events WHERE flock_cycle_id=?",[cycle.id]);assert.ok(Number(events.total)>=4);
  });
  await t.test("equipment/profile are persistent declarations and unknown sensor state fields are rejected",async()=>{
   await request("POST",`/api/coops/${coop.id}/equipment`,operator,{name:"Fan",type:"fan",count:1,rated_watt:45},403);
   const created=await request("POST",`/api/coops/${coop.id}/equipment`,owner,{name:"Panel fan declaration",type:"fan",count:2,rated_watt:45,is_expected_active:true},201);
   const result=await request("GET",`/api/coops/${coop.id}/equipment`,viewer);assert.equal(result.expected_power_w,90);assert.equal(result.equipment.length,1);
   await request("PATCH",`/api/coops/${coop.id}/equipment/${created.equipment.id}`,owner,{reported_state:"off"},400);
   await request("PUT",`/api/flock-cycles/${cycle.id}/profile`,operator,{strain:"Fixture strain",harvest_target_days:35});
   const profile=await request("GET",`/api/flock-cycles/${cycle.id}/profile`,viewer);assert.equal(profile.profile.strain,"Fixture strain");
  });
  await t.test("inventory lists only expose assigned coops and never fabricate physical heartbeat",async()=>{
   device=(await devices.create(owner,{coop_id:coop.id,device_uid:`${marker}-dev`,mqtt_topic_key:`${marker}-topic`,name:"Fixture",device_type:"esp32",firmware_version:"3.1",is_active:true})).device;
   water=(await meters.create(owner,{device_id:device.id,meter_uid:`${marker}-water`,type:"water",channel:"main",unit:"liter",is_active:true,installed_at:null})).meter;
   energy=(await meters.create(owner,{device_id:device.id,meter_uid:`${marker}-energy`,type:"electricity",channel:"main",unit:"kwh",is_active:true,installed_at:null})).meter;
   await devices.create(owner,{coop_id:otherCoop.id,device_uid:`${marker}-other`,mqtt_topic_key:`${marker}-other`,name:"Other",device_type:"esp32",firmware_version:"3.1",is_active:true});
   const listed=await request("GET","/api/devices",operator);assert.deepEqual(listed.devices.map((row)=>row.coop_id),[coop.id]);
   const listedMeters=await request("GET","/api/meters",operator);assert.equal(listedMeters.meters.length,2);
   for(const [meter,values]of[[water,[100,110]],[energy,[20,21]]])for(let index=0;index<2;index++)await ingestion.handleMessage(`coasther/meter/${meter.meter_uid}/reading`,Buffer.from(JSON.stringify({reading_value:values[index],recorded_at:`${placement}T0${index+1}:00:00+08:00`})),{source:"simulation",receivedAt:new Date()});
   const stored=(await request("GET",`/api/devices/${device.id}`,owner)).device;assert.equal(stored.last_seen_at,null);assert.notEqual(stored.connectivity_status,"online");
  });
  await t.test("historical report aggregates accepted source separately with honest null performance",async()=>{
   const sim=await request("GET",`/api/flock-cycles/${cycle.id}/report?source=simulation`,viewer);
   assert.equal(sim.totals.water_liters,10);assert.equal(sim.totals.energy_kwh,1);assert.equal(sim.metrics.fcr,null);assert.equal(sim.source,"simulation");
   const real=await request("GET",`/api/flock-cycles/${cycle.id}/report?source=real`,viewer);assert.equal(real.totals.water_liters,null);assert.equal(real.totals.energy_kwh,null);
   const month=await request("GET",`/api/coops/${coop.id}/reports/monthly?source=simulation`,viewer);assert.equal(month.series[0].water_liters,10);assert.equal(month.series[0].energy_kwh,1);
  });
  await t.test("simultaneous dashboard and advisory GETs preserve canonical parent lock order",async()=>{
   const paths=[`/api/dashboard/summary?coop_id=${coop.id}&include_simulation=true`,`/api/dashboard/charts?coop_id=${coop.id}&include_simulation=true`,`/api/forecasts/current?coop_id=${coop.id}&source=real`,`/api/eco-recommendations?coop_id=${coop.id}&source=real`];
   for(let round=0;round<5;round++)await Promise.all(Array.from({length:3},()=>paths).flat().map((path)=>request("GET",path,owner)));
  });
  await t.test("atomic harvest completes once and UUID retry cannot duplicate population events",async()=>{
   const body={harvested_count:100,actual_harvest_date:today,notes:"Fixture harvest",request_id:crypto.randomUUID()};
   const result=await request("POST",`/api/flock-cycles/${cycle.id}/harvest`,operator,body);assert.equal(result.cycle.current_population,0);assert.equal(result.cycle.status,"completed");
   const replay=await request("POST",`/api/flock-cycles/${cycle.id}/harvest`,operator,body);assert.equal(replay.reused,true);assert.equal(replay.event_id,result.event_id);
   await request("POST",`/api/flock-cycles/${cycle.id}/harvest`,operator,{...body,harvested_count:99},409);
   const report=await request("GET",`/api/flock-cycles/${cycle.id}/report?source=simulation`,viewer);assert.equal(report.metrics.harvested,100);assert.equal(report.totals.water_liters,10);
  });
  await t.test("four-coop creation ceiling is enforced under the farm lock without deleting existing coops",async()=>{
   for(const code of["D3","D4"]){const r=(await coopService.create(owner,{farm_id:farm.id,code,name:marker,capacity_birds:null,description:null,status:"active"})).coop;coops.push(r.id);}
   await assert.rejects(coopService.create(owner,{farm_id:farm.id,code:"D5",name:marker,capacity_birds:null,description:null,status:"active"}),{statusCode:409});
   const list=await coopService.list(owner,{farm_id:farm.id,page:1,limit:100});assert.equal(list.coops.length,4);
  });
  await t.test("revocation denies reads, writes, inventory and the default coop fallback",async()=>{
   await request("DELETE",`/api/coops/${coop.id}/assignments/${operator.id}`,owner);
   await request("GET",`/api/flock-cycles/${cycle.id}/daily-records`,operator,null,403);
   const list=await request("GET","/api/devices",operator);assert.equal(list.devices.length,0);
   const context=await request("GET","/api/dashboard/context",operator);assert.equal(context.state,"no_coop");
  });
 }finally{
  if(server)await new Promise((resolve)=>server.close(resolve));
  try{await cleanup();}finally{await db.end();}
 }
});
