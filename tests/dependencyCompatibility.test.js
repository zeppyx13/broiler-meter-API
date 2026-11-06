const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

test("Nodemailer CommonJS composes existing text/html messages entirely in memory", async (t) => {
  t.mock.method(require("node:net"), "connect", () => { throw Error("Network forbidden in dependency proof"); });
  t.mock.method(require("node:tls"), "connect", () => { throw Error("Network forbidden in dependency proof"); });
  const nodemailer = require("nodemailer");
  const transport = nodemailer.createTransport({ jsonTransport: true, disableFileAccess: true, disableUrlAccess: true });
  const result = await transport.sendMail({ from: { name: "COASTHER Guard", address: "guard@example.invalid" }, to: { address: "operator@example.invalid" }, subject: "Offline compatibility proof", text: "Local message only", html: "<p>Local message only</p>" });
  const mail = JSON.parse(result.message);
  assert.equal(mail.subject, "Offline compatibility proof");
  assert.equal(mail.text, "Local message only");
  assert.equal(mail.html, "<p>Local message only</p>");
  transport.close();
});

test("Sharp CommonJS retains upload resize and JPEG pipeline on local image buffers", async () => {
  const sharp = require("sharp");
  const png = await sharp({ create: { width: 40, height: 20, channels: 3, background: "#336699" } }).png().toBuffer();
  const jpeg = await sharp(png).resize(1200, 800, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer();
  const metadata = await sharp(jpeg).metadata();
  assert.equal(metadata.format, "jpeg");
  assert.equal(metadata.width, 40);
  assert.equal(metadata.height, 20);
});

test("Firebase modular CommonJS exports and migrated FCM helper retain payload without credentials or a provider call", async () => {
  const app = require("firebase-admin/app");
  const messaging = require("firebase-admin/messaging");
  for (const name of ["getApps", "initializeApp", "cert"]) assert.equal(typeof app[name], "function");
  assert.equal(typeof messaging.getMessaging, "function");
  const source = fs.readFileSync(path.join(__dirname, "../src/lib/fcm-sender.js"), "utf8");
  for (const initialized of [false, true]) {
    let sent, created = 0, certified = 0;
    const module = { exports: {} };
    vm.runInNewContext(source, { module, process: { env: { FCM_ADMIN_SDK: "offline-fixture.json" } }, require(id) {
      if (id === "firebase-admin/app") return { getApps: () => initialized ? [{}] : [], initializeApp: () => created++, cert: (value) => { certified++; assert.equal(value.offline, true); return {}; } };
      if (id === "firebase-admin/messaging") return { getMessaging: () => ({ send: async (value) => { sent = value; return "offline-message-id"; } }) };
      if (id === "../config/logger") return { info() {}, error() {} };
      if (id === "../../offline-fixture.json") return { offline: true };
      throw Error(`Unexpected dependency ${id}`);
    } });
    await module.exports.sendNotification({ fcm_token: "synthetic-token", title: "Offline proof", body: "Local stub", data: { coop_id: "1" } });
    assert.equal(sent.token, "synthetic-token");
    assert.equal(sent.android.priority, "high");
    assert.equal(sent.android.notification.channelId, "coasther_default");
    assert.equal(sent.data.coop_id, "1");
    assert.equal(created, initialized ? 0 : 1);
    assert.equal(certified, initialized ? 0 : 1);
  }
});

test("Nodemon scoped Minimatch upgrade preserves source, ignore and extension matching", () => {
  const match = require("nodemon/lib/monitor/match");
  const root = process.cwd();
  const files = ["src/app.js", "src/models/access.model.js", "src/ignored.test.js", "src/metadata.json", "node_modules/vendor/index.js"];
  const result = match(files, [path.join(root, "src", "**", "*"), `!${path.join(root, "src", "**", "*.test.js")}`], "js");
  assert.deepEqual(result.result.map((file) => path.relative(root, file).replaceAll("\\", "/")).sort(), ["src/app.js", "src/models/access.model.js"]);
  assert.equal(result.total, files.length);
});
