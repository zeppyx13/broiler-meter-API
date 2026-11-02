const { ok, fail } = require("../utils/response");
const { runOverdueInvoice } = require("../jobs/overdueInvoice.job");
const { runMonthlyBilling, runMeterReadingsCleanup, getStatus } = require("../jobs/scheduler");

let isManualRunning = false;
let isOverdueRunning = false;

async function triggerOverdue(req, res) {
  if (isOverdueRunning) {
    return fail(res, "Overdue check sedang berjalan", 409);
  }
  isOverdueRunning = true;
  try {
    const result = await runOverdueInvoice();
    return ok(res, result, "Overdue check selesai", 200);
  } catch (err) {
    return fail(res, err.message, err.statusCode || 500);
  } finally {
    isOverdueRunning = false;
  }
}

async function triggerBilling(req, res) {
  if (isManualRunning) {
    return fail(res, "Billing job sedang berjalan, coba beberapa saat lagi", 409);
  }
  isManualRunning = true;
  try {
    const { month } = req.body;

    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      return fail(res, "Format month tidak valid, gunakan YYYY-MM", 400);
    }

    const currentMonth = new Date().toISOString().slice(0, 7);
    if (month > currentMonth) {
      return fail(res, "Cannot trigger billing for future month", 400);
    }

    const result = await runMonthlyBilling(month);
    return ok(res, result, `Billing bulan ${month} selesai`, 200);
  } catch (err) {
    return fail(res, err.message, err.statusCode || 500);
  } finally {
    isManualRunning = false;
  }
}

async function triggerCleanup(req, res) {
  try {
    const result = await runMeterReadingsCleanup();
    return ok(res, result, "Cleanup selesai", 200);
  } catch (err) {
    return fail(res, err.message, err.statusCode || 500);
  }
}

async function getJobStatus(req, res) {
  try {
    const status = getStatus();
    return ok(res, status, "OK", 200);
  } catch (err) {
    return fail(res, err.message, 500);
  }
}

module.exports = { triggerOverdue, triggerBilling, triggerCleanup, getJobStatus };
