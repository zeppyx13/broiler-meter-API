const invoiceAdminModel = require("../models/invoice.admin.model");

function httpError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function recalcTotal(invoice, patch) {
  const rent = Number(invoice.rent_amount);
  const waterCost = Number(invoice.water_cost);
  const elecCost = Number(invoice.elec_cost);
  const fineAmount = Number(patch.fine_amount ?? invoice.fine_amount);
  const discountPercent = Number(
    patch.discount_percent ?? invoice.discount_percent,
  );

  const subtotal = rent + waterCost + elecCost;
  const discountAmount =
    patch.discount_amount !== undefined
      ? Number(patch.discount_amount)
      : Math.round(subtotal * (discountPercent / 100));

  const total = subtotal - discountAmount + fineAmount;

  return { discountAmount, total };
}

async function listInvoices(query) {
  const result = await invoiceAdminModel.findAll(query);
  return {
    invoices: result.rows,
    meta: { total: result.total, page: result.page, limit: result.limit },
  };
}

async function getInvoiceDetail(id) {
  const invoice = await invoiceAdminModel.findById(id);
  if (!invoice) throw httpError("Invoice not found", 404);
  return { invoice };
}

async function updateInvoice(id, payload) {
  const existing = await invoiceAdminModel.findById(id);
  if (!existing) throw httpError("Invoice not found", 404);

  if (
    existing.status === "paid" &&
    payload.status !== undefined &&
    payload.status !== "paid"
  ) {
    throw httpError("Cannot change status of a paid invoice", 400);
  }

  // Recalc total otomatis jika fine atau discount berubah
  if (
    payload.fine_amount !== undefined ||
    payload.discount_percent !== undefined ||
    payload.discount_amount !== undefined
  ) {
    const { discountAmount, total } = recalcTotal(existing, payload);
    payload.discount_amount = discountAmount;
    payload.total_amount = total;
  }

  await invoiceAdminModel.updateById(id, payload);
  return getInvoiceDetail(id);
}

module.exports = { listInvoices, getInvoiceDetail, updateInvoice };
