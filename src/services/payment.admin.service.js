const paymentAdminModel = require("../models/payment.admin.model");

function httpError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

async function listPayments(query) {
  const result = await paymentAdminModel.findAll(query);
  return {
    payments: result.rows,
    meta: { total: result.total, page: result.page, limit: result.limit },
  };
}

async function getPaymentDetail(id) {
  const payment = await paymentAdminModel.findById(id);
  if (!payment) throw httpError("Payment not found", 404);

  const events = await paymentAdminModel.findEventsByPaymentId(id);

  return { payment, events };
}

module.exports = { listPayments, getPaymentDetail };
