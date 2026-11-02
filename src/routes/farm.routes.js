const router = require("express").Router();
const auth = require("../middlewares/auth.middleware");
const controller = require("../controllers/farm.controller");

router.use(auth);
router.get("/", controller.list);
router.post("/", controller.create);
router.get("/:id", controller.detail);
router.patch("/:id", controller.update);
router.put("/:id", controller.update);
router.delete("/:id", controller.remove);
router.get("/:id/members", controller.members);
router.post("/:id/members", controller.addMember);
router.patch("/:id/members/:userId", controller.updateMember);
router.delete("/:id/members/:userId", controller.removeMember);

module.exports = router;
