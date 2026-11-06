const nodemailer = require("nodemailer");
const { z } = require("zod");

function configuration() {
  const port = Number(process.env.SMTP_PORT || process.env.EMAIL_PORT || 587);
  const address =
    process.env.SMTP_FROM ||
    process.env.EMAIL_FROM ||
    process.env.SMTP_USER ||
    process.env.EMAIL_USER ||
    "";
  const host = process.env.SMTP_HOST || process.env.EMAIL_HOST;
  const user = process.env.SMTP_USER || process.env.EMAIL_USER;
  const pass = process.env.SMTP_PASS || process.env.EMAIL_PASS;
  return {
    enabled: process.env.BROILER_EMAIL_ENABLED === "true",
    host,
    port,
    user,
    pass,
    from: address,
    secure:
      process.env.SMTP_SECURE === "true" ||
      (process.env.SMTP_SECURE === undefined && port === 465),
    configured: Boolean(
      host &&
      user &&
      pass &&
      Number.isInteger(port) &&
      port > 0 &&
      port < 65536 &&
      z.email().safeParse(address).success,
    ),
  };
}

function dashboardLink(coopId) {
  try {
    const url = new URL(process.env.WEB_DASHBOARD_URL);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      return null;
    url.search = "";
    url.hash = "";
    url.pathname = `${url.pathname.replace(/\/$/, "")}/dashboard`;
    url.searchParams.set("coop_id", String(coopId));
    return url.toString();
  } catch {
    return null;
  }
}

function message(row) {
  const at = new Date(row.detected_at);
  let localTime;
  try {
    localTime = new Intl.DateTimeFormat("id-ID", {
      timeZone: row.timezone,
      dateStyle: "full",
      timeStyle: "long",
    }).format(at);
  } catch {
    localTime = Number.isFinite(at.getTime())
      ? at.toISOString()
      : "Unavailable";
  }
  const link = dashboardLink(row.coop_id);
  return {
    to: row.email,
    subject: `COASTHER Guard [${row.severity}] ${row.title}`
      .replace(/[\r\n]/g, " ")
      .slice(0, 220),
    text: [
      `COASTHER Guard: ${row.coop_name}`,
      `Alert: ${row.title}`,
      `Type: ${row.alert_type}`,
      `Severity: ${row.severity}`,
      `Detected (${row.timezone}): ${localTime}`,
      `Current status: ${row.alert_status}`,
      "",
      row.body,
      "",
      "This is an indication from deterministic monitoring rules, not proof of an individual equipment failure.",
      "Water readings describe tank inlet flow; panel electrical readings do not identify individual loads.",
      ...(link ? ["", `Dashboard: ${link}`] : []),
    ].join("\n"),
  };
}

async function sendMail(mail, { transport } = {}) {
  const config = configuration();
  if (!config.enabled || !config.configured)
    throw Object.assign(new Error("Email unavailable"), {
      code: "EMAIL_DISABLED",
    });
  // No verify/connect side effect at module import. Credentials remain server-side.
  const sender =
    transport ||
    nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      requireTLS: !config.secure,
      auth: { user: config.user, pass: config.pass },
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 30000,
      tls: { rejectUnauthorized: true },
    });
  return sender.sendMail({
    from: { name: "COASTHER Guard", address: config.from },
    to: { address: mail.to },
    subject: mail.subject,
    text: mail.text,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
}

module.exports = { configuration, dashboardLink, message, sendMail };
