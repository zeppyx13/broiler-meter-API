const router = require("express").Router();
const auth = require("../middlewares/auth.middleware");
const controller = require("../controllers/copilotBroiler.controller");

router.use(auth);
router.get("/conversations", controller.list);
router.post("/conversations", controller.create);
router.get("/conversations/:id", controller.detail);
router.get("/conversations/:id/messages", controller.messages);
router.post("/copilot", controller.send);

module.exports = router;
