const { ok, fail } = require("../utils/response");
const tariffService = require("../services/tariff.service");

async function getTariff(req, res) {
  try {
    const result = await tariffService.getTariff();
    return ok(res, result, "OK", 200);
  } catch (err) {
    return fail(res, err.message, err.statusCode || 500);
  }
}

async function updateTariff(req, res) {
  try {
    const result = await tariffService.updateTariff(req.body);
    return ok(res, result, "Tariff updated", 200);
  } catch (err) {
    return fail(res, err.message, err.statusCode || 400);
  }
}

module.exports = { getTariff, updateTariff };
