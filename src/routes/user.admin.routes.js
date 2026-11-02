const express = require("express");
const router = express.Router();
const auth = require("../middlewares/auth.middleware");
const { requireRole } = require("../middlewares/role.middleware");
const userAdminController = require("../controllers/user.admin.controller");

router.use(auth);
router.use(requireRole(["admin", "manager"]));

router.get("/", userAdminController.list);
router.get("/:id", userAdminController.detail);
router.patch("/:id", userAdminController.update);
router.delete("/:id", userAdminController.remove);

module.exports = router;
