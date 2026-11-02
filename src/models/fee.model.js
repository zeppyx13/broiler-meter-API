const db = require("../config/db");

async function getfreequota() {
  const [rows] = await db.query(
    `SELECT
       electricity_free_quota AS electricQuota,
       water_free_quota       AS waterQuota,
       water_rate             AS waterRate,
       electricity_rate       AS electricRate
     FROM tariff_settings
     LIMIT 1`,
  );

  return {
    electricQuota: Number(rows[0]?.electricQuota || 0),
    waterQuota: Number(rows[0]?.waterQuota || 0),
    waterRate: Number(rows[0]?.waterRate || 0),
    electricRate: Number(rows[0]?.electricRate || 0),
  };
}

async function getTariff() {
  const [rows] = await db.query(
    `SELECT
       id,
       water_rate                AS water_rate,
       water_free_quota          AS water_free_quota,
       electricity_rate          AS electricity_rate,
       electricity_free_quota    AS electricity_free_quota,
       late_fee_flat             AS late_fee_flat,
       updated_at
     FROM tariff_settings
     LIMIT 1`,
  );
  return rows[0] || null;
}

async function updateTariff({
  water_rate,
  water_free_quota,
  electricity_rate,
  electricity_free_quota,
  late_fee_flat,
}) {
  await db.query(
    `UPDATE tariff_settings
     SET
       water_rate             = ?,
       water_free_quota       = ?,
       electricity_rate       = ?,
       electricity_free_quota = ?,
       late_fee_flat          = ?,
       updated_at             = NOW()
     WHERE id = 1`,
    [
      water_rate,
      water_free_quota,
      electricity_rate,
      electricity_free_quota,
      late_fee_flat,
    ],
  );

  return getTariff();
}

module.exports = { getfreequota, getTariff, updateTariff };
