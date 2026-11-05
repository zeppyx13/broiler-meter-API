const router = require("express").Router();
const auth = require("../middlewares/auth.middleware");
const { aiLimiter } = require("../middlewares/rateLimit.middleware");
const controller = require("../controllers/forecast.controller");
router.use(auth);
router.get("/current", controller.current);
router.get("/history", controller.history);
router.post("/generate", aiLimiter, controller.generate);
module.exports = router;
