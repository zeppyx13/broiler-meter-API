const crypto = require("crypto");
const { snap } = require("../config/midtrans");
const paymentModel = require("../models/payment.model");
const userModel = require("../models/user.model");
const { sendMail } = require("../lib/mailer");
const { paymentSuccessTemplate } = require("../lib/emailTemplates");
const { sendNotification } = require("../lib/fcm-sender");
const logger = require("../config/logger");

function httpError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function makeOrderId(invoice) {
  const ts = Date.now();
  return `INV-${invoice.id}-${invoice.month}-${ts}`;
}

function sha512(input) {
  return crypto.createHash("sha512").update(input).digest("hex");
}

function verifyMidtransSignature({
  order_id,
  status_code,
  gross_amount,
  signature_key,
}) {
  const serverKey = process.env.MIDTRANS_SERVER_KEY;
  const raw = `${order_id}${status_code}${gross_amount}${serverKey}`;
  const expected = sha512(raw);
  return expected === signature_key;
}

function mapMidtransToPaymentStatus(transaction_status, fraud_status) {
  if (transaction_status === "settlement") return "paid";
  if (transaction_status === "capture") {
    if (fraud_status === "challenge") return "pending";
    return "paid";
  }
  if (transaction_status === "pending") return "pending";
  if (transaction_status === "expire") return "expired";
  if (transaction_status === "cancel") return "cancelled";
  if (transaction_status === "deny") return "failed";
  if (transaction_status === "failure") return "failed";
  return "pending";
}

function mapPaymentToInvoiceStatus(paymentStatus) {
  if (paymentStatus === "paid") return "paid";
  return null;
}

async function createMidtransTransaction({ userId, invoice_id }) {
  const invoice = await paymentModel.findInvoiceById(invoice_id);
  if (!invoice) throw httpError("Invoice not found", 404);
  if (Number(invoice.user_id) !== Number(userId))
    throw httpError("Forbidden", 403);

  if (!["unpaid", "overdue"].includes(invoice.status)) {
    throw httpError("Invoice is not payable", 400);
  }
  const existingPayment =
    await paymentModel.findLatestPaymentByInvoiceId(invoice_id);
  if (
    existingPayment &&
    existingPayment.status === "pending" &&
    existingPayment.provider === "midtrans"
  ) {
    const metadata = existingPayment.metadata_json
      ? JSON.parse(existingPayment.metadata_json)
      : {};
  }

  const orderId = makeOrderId(invoice);

  const paymentId = await paymentModel.createPayment({
    invoice_id: invoice.id,
    method: "midtrans",
    provider: "midtrans",
    provider_order_id: orderId,
    status: "pending",
    amount: invoice.total_amount,
    metadata_json: JSON.stringify({
      month: invoice.month,
      room_number: invoice.room_number,
    }),
  });

  const params = {
    transaction_details: {
      order_id: orderId,
      gross_amount: invoice.total_amount,
    },
    customer_details: {
      first_name: invoice.user_name,
      email: invoice.user_email,
      phone: invoice.user_phone || undefined,
    },
    item_details: [
      {
        id: `INV-${invoice.id}`,
        price: invoice.total_amount,
        quantity: 1,
        name: `Sewa & Utilitas ${invoice.month} (Kamar ${invoice.room_number})`,
      },
    ],
  };

  let snapRes;
  try {
    snapRes = await snap.createTransaction(params);
  } catch (e) {
    await paymentModel.updatePaymentById(paymentId, {
      status: "failed",
      metadata_json: JSON.stringify({ error: String(e.message || e) }),
    });
    throw httpError("Midtrans transaction failed", 502);
  }

  await paymentModel.updatePaymentById(paymentId, {
    metadata_json: JSON.stringify({
      snap_token: snapRes.token,
      redirect_url: snapRes.redirect_url,
    }),
  });

  return {
    payment_id: paymentId,
    order_id: orderId,
    snap_token: snapRes.token,
    redirect_url: snapRes.redirect_url,
  };
}

async function handleMidtransWebhook(notification) {
  const {
    order_id,
    transaction_status,
    status_code,
    gross_amount,
    signature_key,
    transaction_id,
    fraud_status,
  } = notification;

  if (!order_id) throw httpError("Invalid payload", 400);

  const okSig = verifyMidtransSignature({
    order_id,
    status_code,
    gross_amount,
    signature_key,
  });
  if (!okSig) throw httpError("Invalid signature", 401);

  const payment = await paymentModel.findPaymentByProviderOrder(
    "midtrans",
    order_id,
  );
  if (!payment) {
    return { handled: false, message: "Payment not found (ignored)" };
  }

  await paymentModel.insertPaymentEvent({
    payment_id: payment.id,
    event_type: "midtrans_notification",
    payload_json: JSON.stringify(notification),
  });

  const newPaymentStatus = mapMidtransToPaymentStatus(
    transaction_status,
    fraud_status,
  );

  if (payment.status === "paid") {
    return { handled: true, message: "Already paid (idempotent)" };
  }

  const updateData = {
    provider_transaction_id: transaction_id || null,
    status: newPaymentStatus,
    amount: Number(gross_amount || payment.amount || 0),
  };

  if (newPaymentStatus === "paid") {
    updateData.paid_at = new Date();
  }

  await paymentModel.updatePaymentById(payment.id, updateData);

  const newInvoiceStatus = mapPaymentToInvoiceStatus(newPaymentStatus);
  if (newInvoiceStatus) {
    await paymentModel.updateInvoiceStatus(
      payment.invoice_id,
      newInvoiceStatus,
    );
  }

  if (newPaymentStatus === "paid") {
    try {
      const invoice = await paymentModel.findInvoiceById(payment.invoice_id);

      // FCM Notification
      try {
        const user = await userModel.findById(invoice.user_id);
        if (user?.fcm_token) {
          sendNotification({
            fcm_token: user.fcm_token,
            title: "Pembayaran Berhasil ✅",
            body: `Pembayaran tagihan bulan ${invoice.month} sebesar Rp${updateData.amount.toLocaleString('id-ID')} telah diterima.`,
            data: { type: "payment" }
          }).catch(err => logger.error(`[FCM] Error: ${err.message}`));
        }
      } catch (e) {
        logger.error(`[FCM] Gagal kirim: ${e.message}`);
      }

      if (invoice?.user_email) {
        const { subject, html } = paymentSuccessTemplate({
          name: invoice.user_name,
          month: invoice.month,
          room_number: invoice.room_number,
          amount: updateData.amount,
          paid_at: updateData.paid_at,
          order_id: order_id,
        });

        await sendMail({ to: invoice.user_email, subject, html });
      }
    } catch (mailErr) {
      logger.error(
        `[payment] Gagal kirim email konfirmasi: ${mailErr.message}`,
      );
    }
  }

  return { handled: true, message: "Webhook processed" };
}

module.exports = { createMidtransTransaction, handleMidtransWebhook };
