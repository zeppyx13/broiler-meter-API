const router = require("express").Router();
const auth = require("../middlewares/auth.middleware");
const { relayLimiter } = require("../middlewares/rateLimit.middleware");
const controller = require("../controllers/relayBroiler.controller");

router.use(auth);
router.get("/", controller.list);
router.post("/", controller.create);
router.get("/:id", controller.detail);
router.patch("/:id", controller.update);
router.put("/:id", controller.update);
router.delete("/:id", controller.remove);
router.get("/:id/commands", controller.commands);
router.get("/:id/preflight", controller.preflight);
router.post("/:id/commands", relayLimiter, controller.sendCommand);

module.exports = router;
