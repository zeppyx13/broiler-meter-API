// Controlled GET-only application smoke. No index.js, MQTT, SMTP or Gemini call.
require("dotenv").config({quiet:true});
if(process.env.DB_NAME!=="coasther_broiler"||process.env.BROILER_TEST_DATABASE)throw Error("This read smoke expects the existing Broiler schema");
process.env.BROILER_MQTT_ENABLED="false";process.env.BROILER_EMAIL_ENABLED="false";
const fs=require("node:fs"),jwt=require("jsonwebtoken"),db=require("../config/db"),app=require("../app");
async function counts(){const [tables]=await db.query("SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME");const result={};for(const {TABLE_NAME:name}of tables){if(!/^[a-z_]+$/.test(name))throw Error("Unsafe table");const [[r]]=await db.query(`SELECT COUNT(*) n FROM \`${name}\``);result[name]=Number(r.n);}return result;}
(async()=>{
 const before=await counts();const [[user]]=await db.query("SELECT u.id,u.role FROM users u JOIN farms f ON f.owner_user_id=u.id WHERE u.is_verified=1 ORDER BY f.id LIMIT 1");if(!user)throw Error("No verified farm owner available");
 const token=jwt.sign({id:user.id,role:user.role},process.env.JWT_SECRET,{expiresIn:"3m"});const server=app.listen(0,"127.0.0.1");await new Promise(r=>server.once("listening",r));const base=`http://127.0.0.1:${server.address().port}`;const checks=[];
 async function get(path){const response=await fetch(base+path,{headers:{Authorization:`Bearer ${token}`}});const body=await response.json();checks.push({path,status:response.status,state:body.data?.state??body.code??null,source:body.data?.source??null});return body.data;}
 try{
  await get("/api/auth/me");await get("/api/dashboard/context");const {coops}=await get("/api/coops?limit=100&page=1");
  for(const coop of coops){
   const summary=await get(`/api/dashboard/summary?coop_id=${coop.id}&include_simulation=true`);
   checks.at(-1).observation={real_live_status:summary.live?.status,real_water_liters:summary.today?.water_liters??null,simulation_live_status:summary.simulation?.live?.status,simulation_water_liters:summary.simulation?.today?.water_liters??null};
   await get(`/api/dashboard/charts?coop_id=${coop.id}&metric=all&range=cycle&include_simulation=true`);
   for(const source of["real","simulation"]){const forecast=await get(`/api/forecasts/current?coop_id=${coop.id}&source=${source}`);checks.at(-1).observation={forecasts:forecast?.forecasts?.length??0,required_days:forecast?.required_days??null};const eco=await get(`/api/eco-recommendations?coop_id=${coop.id}&source=${source}&limit=20&page=1`);checks.at(-1).observation={recommendations:eco?.recommendations?.length??0};}
   await get(`/api/flock-cycles/active?coop_id=${coop.id}`);await get(`/api/devices?coop_id=${coop.id}&limit=100&page=1`);await get(`/api/meters?coop_id=${coop.id}&limit=100&page=1`);await get(`/api/coops/${coop.id}/telemetry-history?source=real&minutes=30&bucket_seconds=30`);
  }
  await get("/api/notifications?channel=in_app&limit=20&page=1");
  const after=await counts();const evidence={at:new Date().toISOString(),mode:"GET-only, no physical/provider calls",before,after,checks,unexpected_failures:checks.filter(c=>c.status!==200&&!(c.path.includes("telemetry-history")&&c.status===503))};fs.writeFileSync("docs/audit/result/phase5-active-read-smoke.json",JSON.stringify(evidence,null,2));console.log(JSON.stringify({requests:checks.length,unexpected_failures:evidence.unexpected_failures.length,row_count_changes:Object.keys(before).filter(k=>before[k]!==after[k]).map(k=>({table:k,before:before[k],after:after[k]}))}));if(evidence.unexpected_failures.length)process.exitCode=1;
 }finally{await new Promise(r=>server.close(r));await db.end();}
})().catch(e=>{console.error(e.code||e.message);process.exitCode=1;});
