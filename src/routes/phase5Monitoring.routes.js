const router = require("express").Router();
const auth = require("../middlewares/auth.middleware");
const controller = require("../controllers/phase5Monitoring.controller");
const rateLimit = require("express-rate-limit");
const maintenanceLimiter = rateLimit({
  windowMs: 60000, max: 5, keyGenerator: (req) => String(req.user.id),
  standardHeaders: true, legacyHeaders: false,
  message: { success: false, message: "Terlalu banyak permintaan maintenance; tunggu satu menit." },
});

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
router.get("/coops/:id/maintenance/status", controller.maintenanceStatus);
router.post("/coops/:id/maintenance", maintenanceLimiter, controller.maintenance);
module.exports = router;
