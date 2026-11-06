const router = require("express").Router();
const auth = require("../middlewares/auth.middleware");
const controller = require("../controllers/flockCycle.controller");

router.use(auth);
router.post("/", controller.create);
router.get("/", controller.list);
router.get("/active", controller.active);
router.get("/:id", controller.get);
router.get("/:id/events", controller.events);
router.post("/:id/events", controller.recordEvent);
router.patch("/:id/complete", controller.complete);

module.exports = router;
