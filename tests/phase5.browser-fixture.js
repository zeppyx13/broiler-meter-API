// Explicit isolated browser fixture. Never imports index.js or an MQTT client.
require("dotenv").config({quiet:true});
const crypto=require("node:crypto");
if(process.env.NODE_ENV!=="test" || !/^coasther_broiler_test_[a-z0-9_]+$/.test(process.env.BROILER_TEST_DATABASE||""))throw Error("An isolated test database is required");
process.env.DB_NAME="coasther_broiler";
process.env.BROILER_MQTT_ENABLED="false";
process.env.BROILER_EMAIL_ENABLED="false";
process.env.RATE_LIMIT_GENERAL_MAX="100000";
process.env.RATE_LIMIT_AUTH_MAX="1000";
process.env.JWT_SECRET=crypto.randomBytes(32).toString("hex");
const db=require("../src/config/db");
const bcrypt=require("bcryptjs");
const app=require("../src/app");
const {Server}=require("socket.io");
const farmService=require("../src/services/farm.service");
const coopService=require("../src/services/coop.service");
const flockService=require("../src/services/flockCycle.service");
const domain=require("../src/services/phase5Domain.service");
const {localDate}=require("../src/utils/farmDate");
// Provider-unavailable is intentional and observable; no live Gemini call.
require("../src/services/geminiBroiler.service").generate=async()=>({state:"unavailable",reason:"isolated_browser_fixture",retryable:true});
(async()=>{
 await require("../src/services/schemaCompatibility.service").verify();
 const marker=`browser-${Date.now()}-${crypto.randomBytes(2).toString("hex")}`;
 const users={};
 for(const name of ["owner","manager","operator","viewer"]){
  const email=`${marker}-${name}@example.invalid`;
  const [r]=await db.query("INSERT INTO users (name,email,password_hash,role,is_verified) VALUES (?,?,?,?,1)",[name,email,await bcrypt.hash("Phase5-browser-fixture!",8),name==="owner"||name==="manager"?"manager":"operator"]);
  users[name]={id:r.insertId,role:name==="owner"||name==="manager"?"manager":"operator",email};
 }
 const farm=(await farmService.create(users.owner,{name:`${marker} farm`,timezone:"Asia/Makassar",location_text:null,electricity_rate_idr_per_kwh:1500,water_rate_idr_per_m3:2000})).farm;
 for(const role of["manager","operator","viewer"])await db.query("INSERT INTO farm_members (farm_id,user_id,role) VALUES (?,?,?)",[farm.id,users[role].id,role]);
 const coops=[];
 for(const code of["B1","B2"])coops.push((await coopService.create(users.owner,{farm_id:farm.id,code,name:`${marker} ${code}`,capacity_birds:100,status:"active",description:null})).coop);
 const today=localDate("Asia/Makassar");
 const cycle=await flockService.create(users.owner,{coop_id:coops[0].id,cycle_code:marker,placement_date:today,initial_population:100,planned_harvest_date:null});
 await domain.setAssignment(users.owner,coops[0].id,{user_id:users.operator.id,can_operate:true,relay_operate:false});
 for(const user of Object.values(users))await db.query("UPDATE users SET default_coop_id=? WHERE id=?",[coops[0].id,user.id]);
 const second=(await farmService.create(users.owner,{name:`${marker} second`,timezone:"Asia/Makassar",location_text:null,electricity_rate_idr_per_kwh:1600,water_rate_idr_per_m3:2500})).farm;
 const third=(await coopService.create(users.owner,{farm_id:second.id,code:"C1",name:`${marker} C1`,capacity_birds:100,status:"active",description:null})).coop;
 const outer=require("express")();const http=require("node:http").createServer(outer);const io=new Server(http,{cors:{origin:"*"}});app.set("io",io);require("../src/services/broilerSocket.service").attach(io);
 outer.get("/__fixture",(req,res)=>res.json({users,coops:[...coops,third],farm,second,cycle,today,database:process.env.BROILER_TEST_DATABASE}));
 outer.use(app);
 http.listen(4301,"127.0.0.1",()=>process.stdout.write("Isolated browser fixture ready on 127.0.0.1:4301\n"));
})().catch(error=>{process.stderr.write(error.stack+"\n");process.exit(1);});
