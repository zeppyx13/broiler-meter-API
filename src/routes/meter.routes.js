const express = require("express");
const router = express.Router();
const auth = require("../middlewares/auth.middleware");
const { requireRole } = require("../middlewares/role.middleware");
const meterController = require("../controllers/meter.controller");

router.use(auth);
router.use(requireRole(["admin", "manager"]));

router.get("/", meterController.list);
router.get("/:id", meterController.detail);
router.post("/", meterController.create);
router.patch("/:id", meterController.update);
router.delete("/:id", meterController.remove);

module.exports = router;
