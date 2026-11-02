const { ok, fail } = require("../utils/response");
const invoiceAdminService = require("../services/invoice.admin.service");

async function list(req, res) {
  try {
    const result = await invoiceAdminService.listInvoices(req.query);
    return ok(res, result, "OK", 200);
  } catch (err) {
    return fail(res, err.message, err.statusCode || 500);
  }
}

async function detail(req, res) {
  try {
    const result = await invoiceAdminService.getInvoiceDetail(
      Number(req.params.id),
    );
    return ok(res, result, "OK", 200);
  } catch (err) {
    return fail(res, err.message, err.statusCode || 500);
  }
}

async function update(req, res) {
  try {
    const result = await invoiceAdminService.updateInvoice(
      Number(req.params.id),
      req.body,
    );
    return ok(res, result, "Invoice updated", 200);
  } catch (err) {
    return fail(res, err.message, err.statusCode || 400);
  }
}

module.exports = { list, detail, update };
