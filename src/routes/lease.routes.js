const express = require("express");
const router = express.Router();
const auth = require("../middlewares/auth.middleware");
const { requireRole } = require("../middlewares/role.middleware");
const leaseController = require("../controllers/lease.controller");

router.use(auth);
router.use(requireRole(["admin", "manager"]));

router.get("/", leaseController.list);
router.get("/:id", leaseController.detail);
router.post("/", leaseController.create);
router.patch("/:id", leaseController.update);
router.delete("/:id", leaseController.remove);

module.exports = router;
