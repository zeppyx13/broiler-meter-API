const db = require("../config/db");

async function assignments(coopId, connection = db) {
  const [rows] = await connection.query(
    `SELECT cm.*, u.name, fm.role FROM coop_members cm JOIN coops c ON c.id=cm.coop_id
     JOIN users u ON u.id=cm.user_id JOIN farm_members fm ON fm.farm_id=c.farm_id AND fm.user_id=cm.user_id
     WHERE cm.coop_id=? AND cm.revoked_at IS NULL ORDER BY cm.id`, [coopId]);
  return rows;
}
async function assignment(coopId, userId, connection = db) {
  const [[row]] = await connection.query("SELECT * FROM coop_members WHERE coop_id=? AND user_id=? AND revoked_at IS NULL", [coopId, userId]);
  return row || null;
}
async function roster(farmId, connection = db) {
  const [rows] = await connection.query("SELECT m.user_id,m.role,u.name FROM farm_members m JOIN users u ON u.id=m.user_id WHERE m.farm_id=? ORDER BY m.user_id", [farmId]);
  return rows;
}
async function upsertAssignment(coopId, actor, data, connection) {
  await connection.query(
    `INSERT INTO coop_members (coop_id,user_id,can_operate,relay_operate,assigned_by) VALUES (?,?,?,?,?)
     ON DUPLICATE KEY UPDATE can_operate=VALUES(can_operate),relay_operate=VALUES(relay_operate),assigned_by=VALUES(assigned_by),revoked_at=NULL`,
    [coopId, data.user_id, data.can_operate ? 1 : 0, data.relay_operate ? 1 : 0, actor]);
}
async function revokeAssignment(coopId, userId, connection) {
  await connection.query("UPDATE coop_members SET revoked_at=UTC_TIMESTAMP(),can_operate=0,relay_operate=0 WHERE coop_id=? AND user_id=?", [coopId,userId]);
}
async function audit(coopId, actor, action, resourceId, details, connection) {
  await connection.query("INSERT INTO domain_audit_log (coop_id,actor_id,action,resource_id,detail_json) VALUES (?,?,?,?,?)", [coopId,actor,action,resourceId,JSON.stringify(details)]);
}
async function dailyRecords(cycleId, connection = db) {
  const [rows] = await connection.query(
    `SELECT r.*,DATE_FORMAT(r.record_date,'%Y-%m-%d') AS date FROM flock_daily_records r
     WHERE r.flock_cycle_id=? ORDER BY r.record_date DESC,r.id DESC`, [cycleId]);
  return rows;
}
async function record(cycleId, date, connection) {
  const [[row]] = await connection.query("SELECT *,DATE_FORMAT(record_date,'%Y-%m-%d') AS date FROM flock_daily_records WHERE flock_cycle_id=? AND record_date=? FOR UPDATE", [cycleId,date]);
  return row || null;
}
async function previousRequest(cycleId, requestId, connection) {
  const [[row]] = await connection.query("SELECT * FROM flock_daily_record_revisions WHERE flock_cycle_id=? AND request_id=?", [cycleId,requestId]);
  return row || null;
}
async function saveRecord(cycleId, date, data, actor, revision, isVoid, connection) {
  await connection.query(
    `INSERT INTO flock_daily_records (flock_cycle_id,record_date,dead,culled,avg_weight_g,feed_kg,note,revision,is_void,recorded_by,updated_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE dead=VALUES(dead),culled=VALUES(culled),avg_weight_g=VALUES(avg_weight_g),feed_kg=VALUES(feed_kg),note=VALUES(note),revision=VALUES(revision),is_void=VALUES(is_void),updated_by=VALUES(updated_by)`,
    [cycleId,date,data.dead,data.culled,data.avg_weight_g ?? null,data.feed_kg ?? null,data.note ?? null,revision,isVoid ? 1 : 0,actor,actor]);
  return record(cycleId,date,connection);
}
async function insertRevision(row, requestId, hash, operation, actor, connection) {
  const [result] = await connection.query(
    "INSERT INTO flock_daily_record_revisions (daily_record_id,flock_cycle_id,revision,request_id,payload_hash,operation,snapshot_json,recorded_by) VALUES (?,?,?,?,?,?,?,?)",
    [row.id,row.flock_cycle_id,row.revision,requestId,hash,operation,JSON.stringify(row),actor]);
  return result.insertId;
}
async function linkEvent(revisionId,eventId,category,connection) {
  await connection.query("INSERT INTO flock_daily_record_events (revision_id,event_id,category) VALUES (?,?,?)", [revisionId,eventId,category]);
}
async function revisions(cycleId,date,connection=db) {
  const [rows] = await connection.query(
    `SELECT v.id,v.revision,v.request_id,v.operation,v.snapshot_json,v.recorded_by,v.created_at FROM flock_daily_record_revisions v
     JOIN flock_daily_records r ON r.id=v.daily_record_id WHERE r.flock_cycle_id=? AND r.record_date=? ORDER BY v.revision DESC`, [cycleId,date]);
  return rows;
}
async function populationTimeline(cycleId,connection) {
  const [rows] = await connection.query("SELECT DATE_FORMAT(event_date,'%Y-%m-%d') AS date,SUM(population_change) AS delta FROM flock_events WHERE flock_cycle_id=? GROUP BY event_date ORDER BY event_date", [cycleId]);
  return rows;
}
async function standaloneEvents(cycleId,connection=db) {
  const [rows] = await connection.query(
    `SELECT e.*,DATE_FORMAT(e.event_date,'%Y-%m-%d') AS event_date FROM flock_events e LEFT JOIN flock_daily_record_events l ON l.event_id=e.id
     WHERE e.flock_cycle_id=? AND l.event_id IS NULL ORDER BY e.event_date,e.id`, [cycleId]);
  return rows;
}
async function equipment(coopId,connection=db) {
  const [rows] = await connection.query("SELECT * FROM coop_equipment WHERE coop_id=? ORDER BY id", [coopId]);
  return rows;
}
async function equipmentById(coopId,id,connection) {
  const [[row]] = await connection.query("SELECT * FROM coop_equipment WHERE coop_id=? AND id=? FOR UPDATE", [coopId,id]);
  return row || null;
}
async function createEquipment(coopId,actor,data,connection) {
  const [result] = await connection.query(
    "INSERT INTO coop_equipment (coop_id,name,type,count,rated_watt,unit,is_expected_active,schedule_json,is_active,updated_by) VALUES (?,?,?,?,?,?,?,?,?,?)",
    [coopId,data.name,data.type,data.count,data.rated_watt,data.unit,data.is_expected_active ? 1 : 0,data.schedule ? JSON.stringify(data.schedule) : null,data.is_active ? 1 : 0,actor]);
  return equipmentById(coopId,result.insertId,connection);
}
async function updateEquipment(coopId,id,actor,data,connection) {
  await connection.query(
    "UPDATE coop_equipment SET name=?,type=?,count=?,rated_watt=?,unit=?,is_expected_active=?,schedule_json=?,is_active=?,updated_by=? WHERE coop_id=? AND id=?",
    [data.name,data.type,data.count,data.rated_watt,data.unit,data.is_expected_active ? 1 : 0,data.schedule ? JSON.stringify(data.schedule) : null,data.is_active ? 1 : 0,actor,coopId,id]);
  return equipmentById(coopId,id,connection);
}
async function cycleProfile(cycleId,connection=db) {
  const [[row]] = await connection.query("SELECT * FROM flock_cycle_profiles WHERE flock_cycle_id=?", [cycleId]);
  return row || {flock_cycle_id:cycleId,strain:null,harvest_target_days:null};
}
async function saveCycleProfile(cycleId,actor,data,connection) {
  await connection.query(
    "INSERT INTO flock_cycle_profiles (flock_cycle_id,strain,harvest_target_days,updated_by) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE strain=VALUES(strain),harvest_target_days=VALUES(harvest_target_days),updated_by=VALUES(updated_by)",
    [cycleId,data.strain ?? null,data.harvest_target_days ?? null,actor]);
  return cycleProfile(cycleId,connection);
}
async function updatePlannedDate(cycleId,date,connection) {
  await connection.query("UPDATE flock_cycles SET planned_harvest_date=? WHERE id=?",[date,cycleId]);
}
async function reportExtras(cycleId,source,connection=db) {
  const [[row]] = await connection.query(
    "SELECT COUNT(*) AS guard_events FROM alerts WHERE flock_cycle_id=? AND source=?", [cycleId,source]);
  const [forecasts] = await connection.query("SELECT id,metric,horizon,predicted_value,confidence,generated_at FROM forecasts WHERE flock_cycle_id=? AND is_simulated=? ORDER BY id DESC LIMIT 30", [cycleId,source === 'simulation' ? 1 : 0]);
  const [recommendations] = await connection.query("SELECT id,title,category,status,estimated_savings_idr,generated_at FROM eco_recommendations WHERE flock_cycle_id=? AND source=? ORDER BY id DESC LIMIT 30", [cycleId,source === 'simulation' ? 'simulation' : 'rule']);
  return {guard_events:Number(row.guard_events),forecasts,recommendations};
}
async function harvestRequest(cycleId,requestId,connection) {
  const [[row]]=await connection.query("SELECT * FROM flock_harvest_requests WHERE flock_cycle_id=? AND request_id=?",[cycleId,requestId]);
  return row || null;
}
async function saveHarvestRequest(cycleId,userId,requestId,hash,response,connection) {
  await connection.query("INSERT INTO flock_harvest_requests (flock_cycle_id,request_id,payload_hash,response_json,recorded_by) VALUES (?,?,?,?,?)",[cycleId,requestId,hash,JSON.stringify(response),userId]);
}
module.exports = { assignments,assignment,roster,upsertAssignment,revokeAssignment,audit,dailyRecords,record,previousRequest,saveRecord,insertRevision,linkEvent,revisions,populationTimeline,standaloneEvents,equipment,equipmentById,createEquipment,updateEquipment,cycleProfile,saveCycleProfile,updatePlannedDate,reportExtras,harvestRequest,saveHarvestRequest };
