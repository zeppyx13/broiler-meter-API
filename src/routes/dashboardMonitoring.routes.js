const router = require("express").Router();
const auth = require("../middlewares/auth.middleware");
const controller = require("../controllers/dashboardMonitoring.controller");

router.get("/summary", auth, controller.summary);
router.get("/charts", auth, controller.charts);

module.exports = router;
