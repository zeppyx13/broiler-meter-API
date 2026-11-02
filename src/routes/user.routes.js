const express = require("express");
const router = express.Router();

const authMiddleware = require("../middlewares/auth.middleware");
const userController = require("../controllers/user.controller");
const { requireRole } = require("../middlewares/role.middleware");

router.put("/me", authMiddleware, userController.updateMe);
router.get("/all", authMiddleware, requireRole(["admin"]), userController.getAllUsers);
router.get("/admin", authMiddleware, requireRole(["admin"]), userController.getAdminUsers);
module.exports = router;
