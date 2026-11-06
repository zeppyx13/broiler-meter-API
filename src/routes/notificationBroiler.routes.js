const router = require("express").Router();
const auth = require("../middlewares/auth.middleware");
const controller = require("../controllers/notificationBroiler.controller");

router.use(auth);
router.get("/", controller.list);
router.get("/unread-count", controller.unread);
router.patch("/read-all", controller.readAll);
router.patch("/:id/read", controller.read);

module.exports = router;
