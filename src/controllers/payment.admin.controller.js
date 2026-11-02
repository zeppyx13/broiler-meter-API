const { ok, fail } = require("../utils/response");
const paymentAdminService = require("../services/payment.admin.service");
const {
  listPaymentsQuerySchema,
  paymentIdParamSchema,
} = require("../validators/payment.admin.validator");

async function list(req, res) {
  try {
    const query = listPaymentsQuerySchema.parse(req.query);
    const result = await paymentAdminService.listPayments(query);
    return ok(res, result, "OK", 200);
  } catch (err) {
    return fail(res, err.message, err.statusCode || 500);
  }
}

async function detail(req, res) {
  try {
    const { id } = paymentIdParamSchema.parse(req.params);
    const result = await paymentAdminService.getPaymentDetail(id);
    return ok(res, result, "OK", 200);
  } catch (err) {
    return fail(res, err.message, err.statusCode || 400);
  }
}

module.exports = { list, detail };
