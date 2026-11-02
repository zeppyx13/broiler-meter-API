const express = require("express");
const router = express.Router();

const authMiddleware = require("../middlewares/auth.middleware");
const userController = require("../controllers/user.controller");
const { route } = require("./auth.routes");

router.put("/me", authMiddleware, userController.updateMe);
router.get("/all", userController.getAllUsers);
router.get("/admin", userController.getAdminUsers);
module.exports = router;
