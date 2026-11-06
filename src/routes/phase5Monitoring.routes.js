const router = require("express").Router();
const auth = require("../middlewares/auth.middleware");
const controller = require("../controllers/phase5Monitoring.controller");

router.use(auth);
router.get("/coops/:id/telemetry-history", controller.history);
router.get("/coops/:id/diagnostics", controller.diagnostics);
router.get("/coops/:id/calibrations", controller.calibrations);
router.post("/coops/:id/calibrations", controller.createCalibration);
router.patch("/coops/:id/calibrations/:entryId", controller.verifyCalibration);
router.get("/coops/:id/validation-evidence", controller.evidence);
router.post("/coops/:id/validation-evidence", controller.createEvidence);
router.patch("/coops/:id/validation-evidence/:entryId", controller.verifyEvidence);
router.get("/coops/:id/validation-report", controller.report);
router.post("/coops/:id/maintenance", controller.maintenance);
module.exports = router;
