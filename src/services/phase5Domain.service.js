const crypto = require("node:crypto");
const db = require("../config/db");
const model = require("../models/phase5Domain.model");
const flockModel = require("../models/flockCycle.model");
const flock = require("./flockCycle.service");
const access = require("./access.service");
const schema = require("../utils/phase5Schema");
const transaction = require("../utils/transaction");
const httpError = require("../utils/httpError");
const { localDate, dayAge } = require("../utils/farmDate");
const dailyMetrics = require("./dailyMetrics.service");
const { totals } = require("./dashboardMonitoring.service");

const recordTables = ["flock_daily_records","flock_daily_record_revisions","flock_daily_record_events"];
const numericRecord = (row) => row ? { ...row, dead:Number(row.dead),culled:Number(row.culled),revision:Number(row.revision),is_void:Boolean(row.is_void),avg_weight_g:row.avg_weight_g == null ? null : Number(row.avg_weight_g),feed_kg:row.feed_kg == null ? null : Number(row.feed_kg) } : null;
function decode(value) { try { return typeof value === "string" ? JSON.parse(value) : value; } catch { return null; } }
const presentEquipment = (row) => ({...row,count:Number(row.count),rated_watt:Number(row.rated_watt),is_expected_active:Boolean(row.is_expected_active),is_active:Boolean(row.is_active),schedule:decode(row.schedule_json),measurement_semantics:"Declared equipment; not a sensor reading or relay state"});

async function capabilities(user,coopId) {
  const coop = await access.requireCoop(user,coopId);
  const migrated = await schema.tableAvailable(db,"coop_members");
  const manager = user.role === "admin" || ["owner","manager"].includes(coop.member_role);
  const assigned = coop.member_role === "operator" && migrated ? await model.assignment(coopId,user.id) : null;
  const operate = manager || (coop.member_role === "operator" && (!migrated || Boolean(assigned?.can_operate)));
  return {coop_id:coopId,member_role:coop.member_role || (user.role === "admin" ? "admin" : null),assignment_policy:migrated ? "coop_scoped_operator" : "legacy_farm_membership_until_migration",capabilities:{read:true,operate,manage:manager,"relay:operate":user.role === "admin" || coop.member_role === "owner"}};
}
async function listAssignments(user,coopId) {
  const coop = await access.requireCoop(user,coopId,"manage");
  await schema.requireTables(db,["coop_members"]);
  return {assignments:(await model.assignments(coopId)).map((row) => ({...row,can_operate:Boolean(row.can_operate),relay_operate:Boolean(row.relay_operate)})),members:await model.roster(coop.farm_id)};
}
async function setAssignment(user,coopId,data) {
  return transaction(async (connection) => {
    await schema.requireTables(connection,["coop_members","domain_audit_log"]);
    await access.lockCoop(connection,coopId);
    const coop = await access.requireCoop(user,coopId,"manage",connection);
    const member = (await model.roster(coop.farm_id,connection)).find((row) => Number(row.user_id) === data.user_id);
    if (!member) throw httpError(403,"Only an existing member of this farm can be assigned");
    if (member.role !== "operator") throw httpError(400,"Coop assignment grants apply to farm operators only");
    await model.upsertAssignment(coopId,user.id,data,connection);
    await model.audit(coopId,user.id,"assignment_updated",data.user_id,data,connection);
    return {assignment:await model.assignment(coopId,data.user_id,connection)};
  });
}
async function revokeAssignment(user,coopId,userId) {
  return transaction(async (connection) => {
    await schema.requireTables(connection,["coop_members","domain_audit_log"]);
    await access.lockCoop(connection,coopId);
    await access.requireCoop(user,coopId,"manage",connection);
    await model.revokeAssignment(coopId,userId,connection);
    await model.audit(coopId,user.id,"assignment_revoked",userId,{},connection);
    return {revoked:true,user_id:userId};
  });
}
async function listDaily(user,cycleId) {
  await flock.get(user,cycleId);
  await schema.requireTables(db,recordTables);
  return {records:(await model.dailyRecords(cycleId)).map(numericRecord)};
}
function populationCorrections(previous,next,date) {
  return [["mortality","dead"],["culling","culled"]].flatMap(([category,key]) => {
    const change=Number(next[key])-Number(previous?.[key] || 0);
    if (!change) return [];
    return [{category,event_type:change > 0 ? category : "adjustment",population_change:-change,event_date:date,notes:change > 0 ? `Daily record ${category}` : `Daily record correction: reverse ${category} count`}];
  });
}
function checkTimeline(initial,timeline,capacity) {
  let population=Number(initial);
  for (const row of timeline) {
    population += Number(row.delta);
    if (population < 0 || population > 4294967295 || (capacity != null && population > Number(capacity))) throw httpError(409,"Daily correction would invalidate historical population; review harvest and adjustment events");
  }
  return population;
}
async function saveDaily(user,cycleId,date,input,isVoid=false) {
  const existing=await flock.get(user,cycleId);
  const requestId=input.request_id || crypto.randomUUID();
  const data=isVoid ? {dead:0,culled:0,avg_weight_g:null,feed_kg:null,note:input.note} : {dead:input.dead,culled:input.culled,avg_weight_g:input.avg_weight_g ?? null,feed_kg:input.feed_kg ?? null,note:input.note ?? null};
  const hash=crypto.createHash("sha256").update(JSON.stringify({date,data,is_void:isVoid})).digest("hex");
  return transaction(async (connection) => {
    await schema.requireTables(connection,recordTables);
    await access.lockCoop(connection,existing.coop_id);
    const coop=await access.requireCoop(user,existing.coop_id,"read",connection);
    const cycle=await flockModel.lockById(cycleId,connection);
    await access.requireCoop(user,existing.coop_id,cycle.status === "active" ? "operate" : "manage",connection);
    const replay=await model.previousRequest(cycleId,requestId,connection);
    if (replay) {
      if (replay.payload_hash !== hash) throw httpError(409,"request_id was already used for a different daily record operation");
      return {record:numericRecord(decode(replay.snapshot_json)),cycle:await flockModel.findById(cycleId,connection),request_id:requestId,reused:true};
    }
    if (!["active","completed"].includes(cycle.status)) throw httpError(409,"This cycle does not accept daily records");
    const today=localDate(coop.timezone);
    const last=cycle.actual_harvest_date ? String(cycle.actual_harvest_date).slice(0,10) : today;
    if (date < cycle.placement_date || date > today || date > last) throw httpError(400,"Daily record date must lie within the cycle's farm-local dates");
    const previous=await model.record(cycleId,date,connection);
    if (input.expected_revision != null && input.expected_revision !== Number(previous?.revision || 0)) throw httpError(409,"Daily record changed; reload before applying a correction");
    if (isVoid && !previous) throw httpError(404,"Daily record not found");
    const row=await model.saveRecord(cycleId,date,data,user.id,Number(previous?.revision || 0)+1,isVoid,connection);
    const revisionId=await model.insertRevision(row,requestId,hash,isVoid ? "void" : "upsert",user.id,connection);
    for (const correction of populationCorrections(previous,data,date)) {
      const eventId=await flockModel.insertEvent(cycleId,correction,user.id,connection);
      await model.linkEvent(revisionId,eventId,correction.category,connection);
    }
    const timeline=await model.populationTimeline(cycleId,connection);
    const population=checkTimeline(cycle.initial_population,timeline,coop.capacity_birds);
    await flockModel.updatePopulation(cycleId,population,connection);
    return {record:numericRecord(row),cycle:await flockModel.findById(cycleId,connection),request_id:requestId,reused:false};
  });
}
async function recordRevisions(user,cycleId,date) {
  await flock.get(user,cycleId);
  await schema.requireTables(db,recordTables);
  return {revisions:(await model.revisions(cycleId,date)).map((row) => ({...row,snapshot:decode(row.snapshot_json),snapshot_json:undefined}))};
}
async function harvest(user,cycleId,data) {
  const existing=await flock.get(user,cycleId);
  const hash=crypto.createHash("sha256").update(JSON.stringify({harvested_count:data.harvested_count,actual_harvest_date:data.actual_harvest_date,notes:data.notes || null})).digest("hex");
  return transaction(async(connection)=>{
    await schema.requireTables(connection,["flock_harvest_requests","domain_audit_log"]);
    await access.lockCoop(connection,existing.coop_id);
    const coop=await access.requireCoop(user,existing.coop_id,"operate",connection);
    const cycle=await flockModel.lockById(cycleId,connection);
    const previous=await model.harvestRequest(cycleId,data.request_id,connection);
    if(previous){if(previous.payload_hash!==hash)throw httpError(409,"request_id already belongs to a different harvest request");return {...decode(previous.response_json),reused:true};}
    if(cycle.status!=="active")throw httpError(409,"Only an active cycle can be harvested and completed");
    const lastEvent=await flockModel.latestEventDate(cycleId,connection);
    if(data.actual_harvest_date<cycle.placement_date || data.actual_harvest_date>localDate(coop.timezone) || (lastEvent && data.actual_harvest_date<lastEvent))throw httpError(400,"Harvest date must follow all cycle events and cannot be in the future");
    if(data.harvested_count>Number(cycle.current_population))throw httpError(409,"Harvest count exceeds the remaining population");
    let eventId=null;
    if(data.harvested_count>0)eventId=await flockModel.insertEvent(cycleId,{event_type:"harvest",population_change:-data.harvested_count,event_date:data.actual_harvest_date,notes:data.notes || "Harvest and completion"},user.id,connection);
    await flockModel.updatePopulation(cycleId,Number(cycle.current_population)-data.harvested_count,connection);
    await flockModel.complete(cycleId,data.actual_harvest_date,connection);
    const response={cycle:await flockModel.findById(cycleId,connection),event_id:eventId,request_id:data.request_id,reused:false};
    await model.audit(existing.coop_id,user.id,"cycle_harvested",cycleId,{harvested_count:data.harvested_count,date:data.actual_harvest_date,request_id:data.request_id},connection);
    await model.saveHarvestRequest(cycleId,user.id,data.request_id,hash,response,connection);
    return response;
  });
}
async function equipment(user,coopId) {
  const coop=await access.requireCoop(user,coopId);
  await schema.requireTables(db,["coop_equipment"]);
  const rows=(await model.equipment(coopId)).map(presentEquipment);
  const clock=new Intl.DateTimeFormat("en-GB",{timeZone:coop.timezone,hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(new Date());
  const expected=rows.filter((row) => row.is_active && (row.schedule ? (row.schedule.start <= row.schedule.end ? clock >= row.schedule.start && clock < row.schedule.end : clock >= row.schedule.start || clock < row.schedule.end) : row.is_expected_active));
  return {equipment:rows,expected_power_w:rows.length ? expected.reduce((sum,row) => sum+row.count*row.rated_watt,0) : null,method:"Declared manual state or farm-local daily schedule; not sensor proof",timezone:coop.timezone};
}
async function saveEquipment(user,coopId,equipmentId,data) {
  return transaction(async (connection) => {
    await schema.requireTables(connection,["coop_equipment","domain_audit_log"]);
    await access.lockCoop(connection,coopId);
    await access.requireCoop(user,coopId,"manage",connection);
    let row;
    if (equipmentId) {
      const previous=await model.equipmentById(coopId,equipmentId,connection);
      if (!previous) throw httpError(404,"Equipment not found");
      row=await model.updateEquipment(coopId,equipmentId,user.id,{...presentEquipment(previous),...data},connection);
    } else row=await model.createEquipment(coopId,user.id,data,connection);
    await model.audit(coopId,user.id,equipmentId ? "equipment_updated" : "equipment_created",row.id,{...data},connection);
    return {equipment:presentEquipment(row)};
  });
}
async function profile(user,cycleId,data=null) {
  const cycle=await flock.get(user,cycleId);
  await schema.requireTables(db,["flock_cycle_profiles","domain_audit_log"]);
  if (!data) return {profile:await model.cycleProfile(cycleId)};
  return transaction(async (connection) => {
    await access.lockCoop(connection,cycle.coop_id);
    const locked=await flockModel.lockById(cycleId,connection);
    if (!locked || Number(locked.coop_id)!==Number(cycle.coop_id))throw httpError(409,"Cycle context changed; reload before updating its profile");
    await access.requireCoop(user,locked.coop_id,locked.status === "active" ? "operate" : "manage",connection);
    const previous=await model.cycleProfile(cycleId,connection);
    const next={...previous,...data};
    if (Object.hasOwn(data,"harvest_target_days") && locked.status === "active") {
      const target=next.harvest_target_days == null ? null : new Date(Date.parse(locked.placement_date)+(next.harvest_target_days-1)*86400000).toISOString().slice(0,10);
      await model.updatePlannedDate(cycleId,target,connection);
    }
    const saved=await model.saveCycleProfile(cycleId,user.id,next,connection);
    await model.audit(cycle.coop_id,user.id,"cycle_profile_updated",cycleId,data,connection);
    return {profile:saved};
  });
}
function performance(cycle,records,events) {
  const valid=records.filter((row) => !row.is_void);
  const standalone=(type)=>events.filter((row)=>row.event_type===type).reduce((sum,row)=>sum-Number(row.population_change),0);
  const dead=valid.reduce((sum,row)=>sum+Number(row.dead),0)+standalone("mortality");
  const culled=valid.reduce((sum,row)=>sum+Number(row.culled),0)+standalone("culling");
  const harvested=standalone("harvest");
  const end=cycle.actual_harvest_date || localDate(cycle.timezone);
  const duration=dayAge(cycle.placement_date,end);
  const feedRecords=valid.filter((row)=>row.feed_kg != null);
  const feed=feedRecords.length ? feedRecords.reduce((sum,row)=>sum+Number(row.feed_kg),0) : null;
  const weightRow=valid.filter((row)=>row.avg_weight_g != null).sort((a,b)=>b.date.localeCompare(a.date))[0];
  const weight=weightRow ? Number(weightRow.avg_weight_g) : null;
  const survivors=Number(cycle.initial_population)-dead-culled;
  const birds=cycle.status === "completed" ? (harvested || Number(cycle.current_population)) : Number(cycle.current_population);
  const completeFeed=feedRecords.length >= duration;
  const fcr=completeFeed && feed != null && weight > 0 && birds > 0 ? feed/(birds*weight/1000) : null;
  const survival=Number(cycle.initial_population)>0 ? survivors/Number(cycle.initial_population)*100 : null;
  return {dead,culled,harvested,current_population:Number(cycle.current_population),duration_days:duration,depletion_pct:(dead+culled)/Number(cycle.initial_population)*100,survival_pct:survival,feed_kg:feed,feed_recorded_days:feedRecords.length,feed_coverage_complete:completeFeed,latest_avg_weight_g:weight,weight_record_date:weightRow?.date || null,bird_basis:birds,fcr,performance_index:fcr > 0 && survival != null ? (survival*(weight/1000))/(fcr*duration)*100 : null,provisional:cycle.status !== "completed",limitations:["FCR requires daily feed coverage for every cycle date and a positive sample weight; latest sample is assumed representative.","Inlet water is a proxy, not measured bird intake; no causal mortality prevention claim."]};
}
async function report(user,cycleId,query={source:"real"}) {
  const cycle=await flock.get(user,cycleId);
  await schema.requireTables(db,[...recordTables,"flock_cycle_profiles"]);
  const last=cycle.actual_harvest_date || localDate(cycle.timezone);
  const start=dayAge(cycle.placement_date,last)>366 ? new Date(Date.parse(last)-365*86400000).toISOString().slice(0,10) : cycle.placement_date;
  const computed=await dailyMetrics.recalculateCycle({flock_cycle_id:cycleId,start_date:start,end_date:last});
  const series=query.source === "simulation" ? computed.simulation : computed.real;
  const records=(await model.dailyRecords(cycleId)).map(numericRecord);
  const events=await model.standaloneEvents(cycleId);
  const metrics=performance(cycle,records,events);
  const values=totals(series,metrics.bird_basis);
  const feedMap=new Map(records.filter((row)=>!row.is_void).map((row)=>[row.date,row.feed_kg]));
  const waterFeed=series.filter((point)=>point.water_liters != null && feedMap.get(point.metric_date)>0).map((point)=>({date:point.metric_date,inlet_water_liters:point.water_liters,feed_kg:feedMap.get(point.metric_date),ratio:point.water_liters/feedMap.get(point.metric_date),semantics:"inlet_water_to_feed_proxy"}));
  return {cycle,profile:await model.cycleProfile(cycleId),totals:values,daily_records:records,events:await flockModel.events(cycleId),metrics,series,water_feed:waterFeed,quality:{status:values.status,start_date:start,end_date:last,full_cycle_covered:start===cycle.placement_date,sampling_coverage_verified:false},source:query.source,is_simulated:query.source === "simulation",as_of:new Date().toISOString(),insights:await model.reportExtras(cycleId,query.source),definitions:{water:"Tank inlet volume; not direct drinking intake",electricity:"Aggregate panel energy",tariff:"Current farm tariff, not historically versioned",population_denominator:"Harvested birds when recorded, otherwise remaining/current population",period_limit_days:366}};
}
async function monthly(user,coopId,query={source:"real"}) {
  await access.requireCoop(user,coopId);
  const cycles=await flock.list(user,{coop_id:coopId,limit:100,offset:0});
  const buckets=new Map();
  for (const cycle of cycles) {
    const result=await report(user,cycle.id,query);
    for (const point of result.series) {
      if (point.water_liters == null && point.energy_kwh == null) continue;
      const month=point.metric_date.slice(0,7);
      const bucket=buckets.get(month) || {month,water_liters:null,energy_kwh:null,electricity_cost_idr:null,water_cost_idr:null,water_bird_days:0,energy_bird_days:0,dates:new Set(),quality:"partial",source:query.source};
      for (const field of ["water_liters","energy_kwh","electricity_cost_idr","water_cost_idr"]) if (point[field] != null) bucket[field]=(bucket[field] || 0)+Number(point[field]);
      if (point.water_liters != null) bucket.water_bird_days+=Number(point.population_basis);
      if (point.energy_kwh != null) bucket.energy_bird_days+=Number(point.population_basis);
      bucket.dates.add(point.metric_date);buckets.set(month,bucket);
    }
  }
  return {source:query.source,series:[...buckets.values()].sort((a,b)=>a.month.localeCompare(b.month)).slice(-12).map(({dates,...row})=>({...row,observed_dates:dates.size,water_liters_per_bird_day:row.water_bird_days>0 ? row.water_liters/row.water_bird_days : null,energy_wh_per_bird_day:row.energy_bird_days>0 ? row.energy_kwh*1000/row.energy_bird_days : null})),limitations:["Only evidenced daily buckets are included, no uniform allocation or invented zero months.","At most the 100 most recent cycles and 366 dates per cycle are included."]};
}
module.exports={capabilities,listAssignments,setAssignment,revokeAssignment,listDaily,saveDaily,recordRevisions,harvest,equipment,saveEquipment,profile,report,monthly,populationCorrections,checkTimeline,performance};
