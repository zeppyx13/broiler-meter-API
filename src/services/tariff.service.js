const feeModel = require("../models/fee.model");

function httpError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function validateTariff({
  water_rate,
  water_free_quota,
  electricity_rate,
  electricity_free_quota,
  late_fee_flat,
}) {
  if (water_rate !== undefined && Number(water_rate) < 0)
    throw httpError("water_rate tidak boleh negatif");
  if (water_free_quota !== undefined && Number(water_free_quota) < 0)
    throw httpError("water_free_quota tidak boleh negatif");
  if (electricity_rate !== undefined && Number(electricity_rate) < 0)
    throw httpError("electricity_rate tidak boleh negatif");
  if (
    electricity_free_quota !== undefined &&
    Number(electricity_free_quota) < 0
  )
    throw httpError("electricity_free_quota tidak boleh negatif");
  if (late_fee_flat !== undefined && Number(late_fee_flat) < 0)
    throw httpError("late_fee_flat tidak boleh negatif");
}

async function getTariff() {
  const tariff = await feeModel.getTariff();
  if (!tariff) throw httpError("Tariff settings not found", 404);
  return tariff;
}

async function updateTariff(payload) {
  const current = await feeModel.getTariff();
  if (!current) throw httpError("Tariff settings not found", 404);

  validateTariff(payload);

  const updated = {
    water_rate: Number(payload.water_rate ?? current.water_rate),
    water_free_quota: Number(
      payload.water_free_quota ?? current.water_free_quota,
    ),
    electricity_rate: Number(
      payload.electricity_rate ?? current.electricity_rate,
    ),
    electricity_free_quota: Number(
      payload.electricity_free_quota ?? current.electricity_free_quota,
    ),
    late_fee_flat: Number(payload.late_fee_flat ?? current.late_fee_flat),
  };

  return feeModel.updateTariff(updated);
}

module.exports = { getTariff, updateTariff };
