const router = require("express").Router();
const auth = require("../middlewares/auth.middleware");
const controller = require("../controllers/dashboardContext.controller");

router.get("/context", auth, controller.get);

module.exports = router;
