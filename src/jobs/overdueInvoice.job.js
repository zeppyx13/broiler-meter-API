const overdueModel = require("../models/overdue.model");
const logger = require("../config/logger");
const { sendMail } = require("../lib/mailer");
const { invoiceOverdueTemplate } = require("../lib/emailTemplates");
const { sendNotification } = require("../lib/fcm-sender");
const userModel = require("../models/user.model");
const db = require("../config/db");

async function getUserData(user_id) {
  const [rows] = await db.query(
    `SELECT id, name, email FROM users WHERE id = ? LIMIT 1`,
    [user_id],
  );
  return rows[0] || null;
}

async function getRoomNumber(room_id) {
  const [rows] = await db.query(
    `SELECT number FROM rooms WHERE id = ? LIMIT 1`,
    [room_id],
  );
  return rows[0]?.number || "-";
}

async function runOverdueInvoice() {
  const lateFeeFlat = await overdueModel.getLateFeeFlat();
  const invoices = await overdueModel.findOverdueInvoices();

  if (!invoices.length) {
    logger.info("[overdue] Tidak ada invoice yang perlu diupdate");
    return { updated: 0 };
  }

  let updated = 0;

  for (const inv of invoices) {
    try {
      const rent = Number(inv.rent_amount);
      const water = Number(inv.water_cost);
      const elec = Number(inv.elec_cost);
      const discount = Number(inv.discount_amount);
      const fine = lateFeeFlat;
      const total = rent + water + elec - discount + fine;

      await overdueModel.markOverdueWithFine(inv.id, {
        fine_amount: fine,
        total_amount: total,
      });

      logger.info(
        `[overdue] Invoice #${inv.id} (user:${inv.user_id} room:${inv.room_id} bulan:${inv.month}) → overdue | denda: ${fine} | total baru: ${total}`,
      );

      try {
        const user = await getUserData(inv.user_id);
        const roomNumber = await getRoomNumber(inv.room_id);

        // FCM Notification
        try {
          const fullUser = await userModel.findById(inv.user_id);
          if (fullUser?.fcm_token) {
            sendNotification({
              fcm_token: fullUser.fcm_token,
              title: "Tagihan Terlambat ⚠️",
              body: `Tagihan bulan ${inv.month} kamu sudah melewati jatuh tempo. Segera lakukan pembayaran.`,
              data: { type: "overdue", month: inv.month }
            }).catch(err => logger.error("FCM error:", err));
          }
        } catch (e) {
          logger.error("Gagal kirim FCM:", e);
        }

        if (user?.email) {
          const { subject, html } = invoiceOverdueTemplate({
            name: user.name,
            month: inv.month,
            due_date: inv.due_date,
            total_amount: total,
            fine_amount: fine,
            room_number: roomNumber,
          });

          await sendMail({ to: user.email, subject, html });
          logger.info(
            `[overdue] Email terkirim ke ${user.email} untuk invoice #${inv.id}`,
          );
        }
      } catch (mailErr) {
        logger.error(
          `[overdue] Gagal kirim email invoice #${inv.id}: ${mailErr.message}`,
          mailErr,
        );
      }

      updated++;
    } catch (err) {
      logger.error(
        `[overdue] Gagal update invoice #${inv.id}: ${err.message}`,
        err,
      );
    }
  }

  logger.info(`[overdue] Selesai — ${updated} invoice diupdate`);
  return { updated };
}

module.exports = { runOverdueInvoice };
