const { ok, fail } = require("../utils/response");
const invoiceService = require("../services/invoice.service");
const {
  listMyInvoicesQuerySchema,
} = require("../validators/invoice.validator");

async function myCurrentInvoice(req, res) {
  try {
    const result = await invoiceService.getMyCurrentInvoice(req.user.id);
    return ok(res, result, "OK", 200);
  } catch (err) {
    return fail(res, err.message, err.statusCode || 400);
  }
}

async function myInvoices(req, res) {
  try {
    const query = listMyInvoicesQuerySchema.parse(req.query);
    const result = await invoiceService.listMyInvoices(req.user.id, query);
    return ok(res, result, "OK", 200);
  } catch (err) {
    return fail(res, err.message, err.statusCode || 400);
  }
}

module.exports = { myCurrentInvoice, myInvoices };
