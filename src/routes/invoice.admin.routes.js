const express = require("express");
const router = express.Router();
const auth = require("../middlewares/auth.middleware");
const { requireRole } = require("../middlewares/role.middleware");
const invoiceController = require("../controllers/invoice.admin.controller");

router.use(auth);
router.use(requireRole(["admin", "manager"]));

router.get("/", invoiceController.list);
router.get("/:id", invoiceController.detail);
router.patch("/:id", invoiceController.update);

module.exports = router;
