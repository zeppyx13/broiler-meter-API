const midtransClient = require("midtrans-client");

const isProduction = String(process.env.MIDTRANS_IS_PRODUCTION) === "true";

const snap = new midtransClient.Snap({
  isProduction,
  serverKey: process.env.MIDTRANS_SERVER_KEY,
  clientKey: process.env.MIDTRANS_CLIENT_KEY,
});

module.exports = { snap, isProduction };
