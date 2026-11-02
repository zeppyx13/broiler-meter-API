const { ok, fail } = require("../utils/response");
const paymentService = require("../services/payment.service");
const {
  createMidtransPaymentSchema,
} = require("../validators/payment.validator");

async function createMidtrans(req, res) {
  try {
    const payload = createMidtransPaymentSchema.parse(req.body);
    const result = await paymentService.createMidtransTransaction({
      userId: req.user.id,
      invoice_id: payload.invoice_id,
    });
    return ok(res, result, "Midtrans transaction created", 201);
  } catch (err) {
    if (String(err.message || "").includes("Duplicate")) {
      return fail(res, "Duplicate order id, retry", 409);
    }
    return fail(res, err.message, err.statusCode || 400);
  }
}

async function midtransWebhook(req, res) {
  try {
    const result = await paymentService.handleMidtransWebhook(req.body);
    return ok(res, result, "OK", 200);
  } catch (err) {
    return fail(res, err.message, err.statusCode || 400);
  }
}

module.exports = { createMidtrans, midtransWebhook };
