const router = require("express").Router();
const auth = require("../middlewares/auth.middleware");
const controller = require("../controllers/ecoAdvisor.controller");
const { aiLimiter } = require("../middlewares/rateLimit.middleware");

router.use(auth);
router.get("/", controller.list);
router.post("/generate", aiLimiter, controller.generate);
router.patch("/:id/status", controller.setStatus);

module.exports = router;
