const invoiceModel = require("../models/invoice.model");

function httpError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function getCurrentMonthYYYYMM() {
  const d = new Date();
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

async function getMyCurrentInvoice(userId) {
  const month = getCurrentMonthYYYYMM();
  const invoice = await invoiceModel.findMyInvoiceByMonth(userId, month);

  if (!invoice) {
    throw httpError("Invoice for current month not found", 404);
  }

  const latestPayment = await invoiceModel.findLatestPaymentByInvoiceId(
    invoice.id,
  );

  return { month, invoice, latest_payment: latestPayment };
}

async function listMyInvoices(userId, query) {
  const result = await invoiceModel.findMyInvoices({
    user_id: userId,
    status: query.status,
    page: query.page,
    limit: query.limit,
  });

  return {
    invoices: result.rows,
    meta: { total: result.total, page: result.page, limit: result.limit },
  };
}

module.exports = { getMyCurrentInvoice, listMyInvoices };
