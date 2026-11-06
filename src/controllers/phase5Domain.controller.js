const service=require("../services/phase5Domain.service");
const v=require("../validators/phase5Domain.validator");
const {ok}=require("../utils/response");
const id=(req)=>v.idParam.parse(req.params).id;
const resource=(req)=>v.resourceParam.parse(req.params);
const daily=(req)=>v.dailyParam.parse(req.params);
const empty=(req)=>v.emptyQuery.parse(req.query);
module.exports={
  capabilities:async(req,res)=>{empty(req);return ok(res,await service.capabilities(req.user,id(req)));},
  assignments:async(req,res)=>{empty(req);return ok(res,await service.listAssignments(req.user,id(req)));},
  setAssignment:async(req,res)=>{empty(req);return ok(res,await service.setAssignment(req.user,id(req),v.assignmentSchema.parse(req.body)));},
  revokeAssignment:async(req,res)=>{empty(req);const p=v.assignmentParam.parse(req.params);return ok(res,await service.revokeAssignment(req.user,p.id,p.userId));},
  daily:async(req,res)=>{empty(req);return ok(res,await service.listDaily(req.user,id(req)));},
  saveDaily:async(req,res)=>{empty(req);const p=daily(req);return ok(res,await service.saveDaily(req.user,p.id,p.date,v.recordSchema.parse(req.body)));},
  voidDaily:async(req,res)=>{empty(req);const p=daily(req);return ok(res,await service.saveDaily(req.user,p.id,p.date,v.voidSchema.parse(req.body),true));},
  revisions:async(req,res)=>{empty(req);const p=daily(req);return ok(res,await service.recordRevisions(req.user,p.id,p.date));},
  harvest:async(req,res)=>{empty(req);return ok(res,await service.harvest(req.user,id(req),v.harvestSchema.parse(req.body)));},
  equipment:async(req,res)=>{empty(req);return ok(res,await service.equipment(req.user,id(req)));},
  createEquipment:async(req,res)=>{empty(req);return ok(res,await service.saveEquipment(req.user,id(req),null,v.equipmentCreate.parse(req.body)),"Equipment created",201);},
  updateEquipment:async(req,res)=>{empty(req);const p=resource(req);return ok(res,await service.saveEquipment(req.user,p.id,p.resourceId,v.equipmentUpdate.parse(req.body)));},
  disableEquipment:async(req,res)=>{empty(req);const p=resource(req);return ok(res,await service.saveEquipment(req.user,p.id,p.resourceId,{is_active:false}));},
  profile:async(req,res)=>{empty(req);return ok(res,await service.profile(req.user,id(req)));},
  saveProfile:async(req,res)=>{empty(req);return ok(res,await service.profile(req.user,id(req),v.profileSchema.parse(req.body)));},
  report:async(req,res)=>ok(res,await service.report(req.user,id(req),v.sourceQuery.parse(req.query))),
  monthly:async(req,res)=>ok(res,await service.monthly(req.user,id(req),v.sourceQuery.parse(req.query))),
};
