const { ok } = require("../utils/response");
const service = require("../services/phase5Monitoring.service");
const schema = require("../validators/phase5Monitoring.validator");

const id = (req) => schema.params.parse(req.params).id;
async function history(req, res) { return ok(res, await service.telemetryHistory(req.user, id(req), schema.historyQuery.parse(req.query))); }
async function diagnostics(req, res) { return ok(res, await service.diagnostics(req.user, id(req), schema.listQuery.parse(req.query))); }
async function calibrations(req, res) { return ok(res, await service.listCalibrations(req.user, id(req), schema.listQuery.parse(req.query))); }
async function createCalibration(req, res) { return ok(res, await service.createCalibration(req.user, id(req), schema.calibrationSchema.parse(req.body)), "Calibration observation recorded", 201); }
async function verifyCalibration(req, res) { const { id, entryId } = schema.entryParams.parse(req.params); return ok(res, await service.verifyCalibration(req.user, id, entryId, schema.verificationSchema.parse(req.body))); }
async function evidence(req, res) { return ok(res, await service.listEvidence(req.user, id(req), schema.listQuery.parse(req.query))); }
async function createEvidence(req, res) { return ok(res, await service.createEvidence(req.user, id(req), schema.evidenceSchema.parse(req.body)), "Validation evidence recorded", 201); }
async function verifyEvidence(req, res) { const { id, entryId } = schema.entryParams.parse(req.params); return ok(res, await service.verifyEvidence(req.user, id, entryId, schema.verificationSchema.parse(req.body))); }
async function report(req, res) { return ok(res, await service.validationReport(req.user, id(req), schema.listQuery.parse(req.query))); }
async function maintenance(req, res) {
  const data = await service.maintenance(req.user, id(req), schema.maintenanceSchema.parse(req.body));
  return res.status(409).json({ success: false, message: "requires_hardware_acceptance", data });
}
async function maintenanceStatus(req, res) {
  schema.emptyQuery.parse(req.query);
  return ok(res, await service.maintenanceStatus(req.user, id(req)));
}
module.exports = { history, diagnostics, calibrations, createCalibration, verifyCalibration, evidence, createEvidence, verifyEvidence, report, maintenance, maintenanceStatus };
