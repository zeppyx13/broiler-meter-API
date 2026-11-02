const nodemailer = require("nodemailer");
const dotenv = require("dotenv");
const logger = require("../config/logger");
dotenv.config();
const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: Number(process.env.EMAIL_PORT),
  secure: true,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

async function sendMail({ to, subject, html }) {
  return transporter.sendMail({
    from: process.env.EMAIL_USER,
    to,
    subject,
    html,
  });
}
transporter
  .verify()
  .then(() => logger.info("SMTP ready"))
  .catch((err) => logger.error(err));
module.exports = { sendMail };
