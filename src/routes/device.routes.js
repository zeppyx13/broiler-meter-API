const router = require("express").Router();
const auth = require("../middlewares/auth.middleware");
const controller = require("../controllers/device.controller");

router.use(auth);
router.get("/", controller.list);
router.post("/", controller.create);
router.get("/:id", controller.detail);
router.patch("/:id", controller.update);
router.put("/:id", controller.update);
router.delete("/:id", controller.remove);

module.exports = router;
