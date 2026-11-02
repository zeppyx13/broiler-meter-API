const express = require("express");
const router = express.Router();

const auth = require("../middlewares/auth.middleware");
const { requireRole } = require("../middlewares/role.middleware");
const tenantController = require("../controllers/tenant.controller");
const invoiceController = require("../controllers/invoice.controller");
const usageTenantController = require("../controllers/usageTenant.controller");
const leaseController = require("../controllers/lease.controller");

router.use(auth);
router.use(requireRole(["tenant", "admin", "manager"]));

router.get("/my-room", tenantController.myRoom);
router.get("/my-invoices/current", invoiceController.myCurrentInvoice);
router.get("/my-invoices", invoiceController.myInvoices);
router.get("/my-usage", usageTenantController.myUsage);
router.get("/my-meter-readings", usageTenantController.myMeterReadings);
router.post("/booking", leaseController.tenantBooking);
module.exports = router;
