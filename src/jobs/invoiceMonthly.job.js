const invoiceModel = require("../models/invoiceMonthly.model");
const { sendMail } = require("../lib/mailer");
const { invoiceCreatedTemplate } = require("../lib/emailTemplates");
const { sendNotification } = require("../lib/fcm-sender");
const userModel = require("../models/user.model");
const db = require("../config/db");
const logger = require("../config/logger");

function httpError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function assertYYYYMM(month) {
  if (!/^\d{4}-\d{2}$/.test(month)) {
    throw httpError("month must be in YYYY-MM format", 400);
  }
  const [y, m] = month.split("-").map(Number);
  if (m < 1 || m > 12) throw httpError("Invalid month", 400);
  return { y, m };
}

function getMonthRangeUTC(month) {
  const { y, m } = assertYYYYMM(month);
  const startAt = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0));
  const endAt = new Date(Date.UTC(y, m, 1, 0, 0, 0));
  return { startAt, endAt };
}

function toDateOnlyUTC(d) {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function calcDueDateUTC(month) {
  const { y, m } = assertYYYYMM(month);
  const due = new Date(Date.UTC(y, m, 5, 0, 0, 0));
  return toDateOnlyUTC(due);
}

function roundInt(n) {
  return Math.round(Number(n || 0));
}

function toNumber3(x) {
  const n = Number(x || 0);
  return Math.round(n * 1000) / 1000;
}

async function generateInvoicesForMonth(month) {
  const tariff = await invoiceModel.getTariffSettings();
  if (!tariff) throw httpError("Tariff settings not found (id=1)", 500);

  const { startAt, endAt } = getMonthRangeUTC(month);
  const startDate = toDateOnlyUTC(startAt);
  const endDate = toDateOnlyUTC(endAt);

  const leases = await invoiceModel.findLeasesOverlappingMonth(
    startDate,
    endDate,
  );
  
  if (!leases.length) return { month, leases_processed: 0 };

  const roomIds = leases.map(l => l.room_id);
  const userIds = [...new Set(leases.map(l => l.user_id))];

  const [usageList, userList] = await Promise.all([
    invoiceModel.findUsageMonthlyBulk(roomIds, month),
    userModel.findByIds(userIds)
  ]);

  const usageMap = usageList.reduce((map, usage) => {
    map[usage.room_id] = usage;
    return map;
  }, {});

  const userMap = userList.reduce((map, user) => {
    map[user.id] = user;
    return map;
  }, {});

  const due_date = calcDueDateUTC(month);
  let processed = 0;

  for (const lease of leases) {
    const usage = usageMap[lease.room_id];

    const water_used_liter = toNumber3(usage?.water_used ?? 0);
    const water_used = toNumber3(water_used_liter / 1000);
    const elec_used = toNumber3(usage?.elec_used ?? 0);

    const water_billable = Math.max(
      0,
      water_used - Number(tariff.water_free_quota),
    );
    const elec_billable = Math.max(
      0,
      elec_used - Number(tariff.electricity_free_quota),
    );

    const water_cost = roundInt(water_billable * Number(tariff.water_rate));
    const elec_cost = roundInt(elec_billable * Number(tariff.electricity_rate));
    const rent_amount = roundInt(lease.monthly_rent_snapshot);

    const fine_amount = 0;
    const discount_percent = 0;
    const discount_amount = 0;
    const total_amount =
      rent_amount + water_cost + elec_cost - discount_amount + fine_amount;
    const status = "unpaid";

    try {
      await invoiceModel.upsertInvoice({
        lease_id: lease.lease_id,
        room_id: lease.room_id,
        user_id: lease.user_id,
        month,
        due_date,
        rent_amount,
        water_used,
        water_cost,
        elec_used,
        elec_cost,
        fine_amount,
        discount_percent,
        discount_amount,
        total_amount,
        status,
      });

      const user = userMap[lease.user_id];
      if (user) {
        if (user.fcm_token) {
          sendNotification({
            fcm_token: user.fcm_token,
            title: "Tagihan Baru 📋",
            body: `Tagihan bulan ${month} sebesar Rp${total_amount.toLocaleString('id-ID')} sudah tersedia.`,
            data: { type: "invoice", month }
          }).catch(err => logger.error(`[FCM] Error: ${err.message}`));
        }

        if (user.email) {
          const { subject, html } = invoiceCreatedTemplate({
            name: user.name,
            month,
            due_date,
            total_amount,
            room_number: lease.room_number,
          });

          await sendMail({ to: user.email, subject, html });
        }
      }
    } catch (err) {
      logger.error(`[invoice] Gagal proses lease ${lease.lease_id}: ${err.message}`);
    }

    processed += 1;
  }

  return {
    month,
    due_date,
    leases_processed: processed,
  };
}

module.exports = { generateInvoicesForMonth };
