const { test } = require("node:test");
const assert = require("node:assert/strict");
const db = require("../src/config/db");
const access = require("../src/services/access.service");
const model = require("../src/models/notificationBroiler.model");
const emailModel = require("../src/models/notificationEmailBroiler.model");
const service = require("../src/services/notificationBroiler.service");
const worker = require("../src/services/notificationEmailBroiler.service");
const mailer = require("../src/services/notificationMailBroiler.service");
const schema = require("../src/validators/notificationBroiler.validator");
const socket = require("../src/services/broilerSocket.service");

process.env.BROILER_EMAIL_ENABLED = "true";
process.env.SMTP_HOST = "smtp.example.invalid";
process.env.SMTP_PORT = "587";
process.env.SMTP_USER = "sender@example.invalid";
process.env.SMTP_PASS = "synthetic-test-only";
process.env.SMTP_FROM = "sender@example.invalid";

function mockTransaction(t, calls = []) {
  const connection = {
    beginTransaction: async () => calls.push("begin"),
    commit: async () => calls.push("commit"),
    rollback: async () => calls.push("rollback"),
    release: () => calls.push("release"),
  };
  t.mock.method(db, "getConnection", async () => connection);
  t.mock.method(access, "lockCoop", async () => calls.push("parent_lock"));
  return connection;
}

function emailRow(overrides = {}) {
  return {
    id: 1,
    user_id: 2,
    alert_id: 3,
    coop_id: 4,
    farm_id: 5,
    channel: "email",
    delivery_status: "pending",
    title: "Suspected panel load anomaly",
    body: "Indication only; check panel conditions.",
    source: "rule",
    severity: "warning",
    alert_type: "suspected_power_anomaly",
    alert_status: "active",
    coop_name: "Test Coop",
    timezone: "Asia/Makassar",
    detected_at: new Date("2026-11-05T00:00:00Z"),
    email: "recipient@example.invalid",
    recipient_role: "operator",
    sent_at: null,
    read_at: null,
    error_message: JSON.stringify({ state: "queued", attempts: 0 }),
    ...overrides,
  };
}

function mockQueue(t, row, calls = []) {
  mockTransaction(t, calls);
  t.mock.method(emailModel, "candidates", async () =>
    row.delivery_status === "pending"
      ? [{ id: row.id, coop_id: row.coop_id }]
      : [],
  );
  t.mock.method(emailModel, "lockContext", async () => ({ ...row }));
  t.mock.method(emailModel, "setState", async (id, status, audit, sentAt) => {
    Object.assign(row, {
      delivery_status: status,
      error_message: JSON.stringify(audit),
      sent_at: sentAt,
    });
    calls.push(`state:${audit.state}`);
  });
  t.mock.method(
    emailModel,
    "finishClaim",
    async (id, expected, status, audit, sentAt) => {
      if (row.error_message !== expected) return false;
      Object.assign(row, {
        delivery_status: status,
        error_message: JSON.stringify(audit),
        sent_at: sentAt,
      });
      calls.push(`finish:${audit.state}`);
      return true;
    },
  );
}

test("notification API rejects recipient injection, FCM and invalid pagination", () => {
  assert.equal(schema.querySchema.parse({}).channel, "in_app");
  for (const payload of [
    { user_id: "99" },
    { channel: "fcm" },
    { to: "outsider@example.invalid" },
    { limit: "101" },
  ]) {
    assert.equal(schema.querySchema.safeParse(payload).success, false);
  }
  assert.equal(
    schema.querySchema.parse({ channel: "email", unread: "true" }).unread,
    true,
  );
  assert.equal(schema.emptyBody.safeParse({ user_id: 99 }).success, false);
});

test("new alert creates exactly one web and email record per authorized recipient and repeated calls reuse rows", async (t) => {
  const alert = {
    id: 3,
    coop_id: 4,
    title: "Suspected load anomaly",
    message: "Check the panel",
    severity: "warning",
    source: "rule",
  };
  const rows = [];
  t.mock.method(model, "lockAlert", async () => alert);
  t.mock.method(model, "recipients", async () => [
    { id: 2, email: "one@example.invalid" },
    { id: 6, email: "two@example.invalid" },
  ]);
  t.mock.method(model, "existing", async (alertId, userId, channel) =>
    rows.find((row) => row.user_id === userId && row.channel === channel),
  );
  t.mock.method(model, "create", async (data) => {
    rows.push({ ...data, id: rows.length + 1, coop_id: 4, source: "rule" });
    return rows.length;
  });
  t.mock.method(model, "findById", async (id) =>
    rows.find((row) => row.id === id),
  );
  const first = await service.createForAlert({}, alert, { id: 4, farm_id: 5 });
  const second = await service.createForAlert({}, alert, { id: 4, farm_id: 5 });
  assert.equal(first.length, 4);
  assert.equal(second.length, 0);
  assert.equal(
    rows.filter(
      (row) => row.channel === "in_app" && row.delivery_status === "sent",
    ).length,
    2,
  );
  assert.equal(
    rows.filter(
      (row) => row.channel === "email" && row.delivery_status === "pending",
    ).length,
    2,
  );
  assert.equal(
    rows.some((row) => row.channel === "fcm"),
    false,
  );
});

test("simulation notifications are labeled and their email audit is suppressed without SMTP", async (t) => {
  const alert = {
    id: 3,
    coop_id: 4,
    title: "Suspected anomaly",
    message: "Indication",
    severity: "critical",
    source: "simulation",
  };
  const rows = [];
  t.mock.method(model, "lockAlert", async () => alert);
  t.mock.method(model, "recipients", async () => [
    { id: 2, email: "recipient@example.invalid" },
  ]);
  t.mock.method(model, "existing", async () => null);
  t.mock.method(model, "create", async (data) => {
    rows.push({
      ...data,
      id: rows.length + 1,
      coop_id: 4,
      source: "simulation",
    });
    return rows.length;
  });
  t.mock.method(model, "findById", async (id) => rows[id - 1]);
  const send = t.mock.method(mailer, "sendMail", async () =>
    assert.fail("Simulation must not reach SMTP"),
  );
  await service.createForAlert({}, alert, { id: 4, farm_id: 5 });
  assert.equal(rows[0].title.startsWith("[SIMULATION]"), true);
  assert.equal(rows[1].delivery_status, "failed");
  assert.equal(
    service.metadata(rows[1].error_message).reason,
    "simulation_suppressed",
  );
  assert.equal(send.mock.callCount(), 0);
});

test("after-commit notification delivery targets recipients and never sends SMTP inline", async (t) => {
  const events = [];
  t.mock.method(socket, "publish", async (io, event, payload) =>
    events.push({ event, payload }),
  );
  const send = t.mock.method(mailer, "sendMail", async () =>
    assert.fail("afterAlert only queues SMTP"),
  );
  const result = await service.afterAlert(
    { id: 3 },
    [emailRow({ channel: "in_app", delivery_status: "sent" }), emailRow()],
    {},
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "notification_created");
  assert.equal(events[0].payload.user_id, 2);
  assert.equal(events[0].payload.coop_id, 4);
  assert.equal(result.email_pending, 1);
  assert.equal(send.mock.callCount(), 0);
});

test("notification read rejects other-user IDs and revoked/viewer memberships", async (t) => {
  mockTransaction(t);
  const row = emailRow({ channel: "in_app" });
  t.mock.method(model, "findById", async () => row);
  const update = t.mock.method(model, "markRead", async () =>
    assert.fail("Unauthorized read marker must not update"),
  );
  await assert.rejects(service.read({ id: 99 }, 1), { statusCode: 404 });
  t.mock.method(access, "requireCoop", async () => ({
    id: 4,
    member_role: "viewer",
  }));
  await assert.rejects(service.read({ id: 2, role: "operator" }, 1), {
    statusCode: 403,
  });
  assert.equal(update.mock.callCount(), 0);
});

test("public delivery audit excludes claims and untrusted SMTP exception details", () => {
  const row = emailRow({
    error_message: JSON.stringify({
      state: "sending",
      claim: "private-claim",
      attempts: 1,
      reason: "password=private;raw SMTP reply",
    }),
  });
  const output = service.present(row);
  assert.equal(output.attempt_count, 1);
  assert.equal(output.error_message, "delivery_failed");
  assert.equal(JSON.stringify(output).includes("private"), false);
  assert.equal("email" in output, false);
});

test("SMTP acceptance is recorded after a committed durable claim with membership-derived recipient", async (t) => {
  const calls = [];
  const row = emailRow();
  mockQueue(t, row, calls);
  const transport = {
    sendMail: async (message) => {
      assert.equal(calls.includes("commit"), true);
      assert.equal(row.delivery_status, "pending");
      assert.equal(service.metadata(row.error_message).state, "sending");
      assert.deepEqual(message.to, { address: "recipient@example.invalid" });
      assert.equal(message.from.address, "sender@example.invalid");
      assert.equal(message.text.includes("not proof"), true);
      return { accepted: ["recipient@example.invalid"], rejected: [] };
    },
  };
  const result = await worker.processPending({
    transport,
    now: new Date("2026-11-05T00:00:00Z"),
  });
  assert.equal(result.sent, 1);
  assert.equal(row.delivery_status, "sent");
  assert.equal(service.metadata(row.error_message).state, "smtp_accepted");
  assert.ok(row.sent_at instanceof Date);
});

test("known pre-accept connection failures retry at most three times without new records", async (t) => {
  const row = emailRow();
  mockQueue(t, row);
  let attempts = 0;
  const transport = {
    sendMail: async () => {
      attempts++;
      throw Object.assign(new Error("synthetic password must not persist"), {
        code: "ECONNREFUSED",
      });
    },
  };
  const now = new Date("2026-11-05T00:00:00Z");
  assert.equal((await worker.processPending({ transport, now })).retry, 1);
  assert.equal(
    service.metadata(row.error_message).next_at,
    "2026-11-05T00:00:30.000Z",
  );
  assert.equal(
    (
      await worker.processPending({
        transport,
        now: new Date(now.getTime() + 29000),
      })
    ).processed,
    0,
  );
  assert.equal(
    (
      await worker.processPending({
        transport,
        now: new Date(now.getTime() + 30000),
      })
    ).retry,
    1,
  );
  assert.equal(
    service.metadata(row.error_message).next_at,
    "2026-11-05T00:02:30.000Z",
  );
  assert.equal(
    (
      await worker.processPending({
        transport,
        now: new Date(now.getTime() + 150000),
      })
    ).failed,
    1,
  );
  assert.equal(attempts, 3);
  assert.equal(row.delivery_status, "failed");
  assert.equal(service.metadata(row.error_message).attempts, 3);
  assert.equal(row.error_message.includes("password"), false);
});

test("unknown SMTP outcome becomes terminal ambiguous and is never automatically resent", async (t) => {
  const row = emailRow();
  mockQueue(t, row);
  let attempts = 0;
  const transport = {
    sendMail: async () => {
      attempts++;
      throw Object.assign(new Error("Connection lost after DATA"), {
        code: "ECONNRESET",
        command: "DATA",
      });
    },
  };
  assert.equal((await worker.processPending({ transport })).ambiguous, 1);
  assert.equal(service.metadata(row.error_message).state, "ambiguous");
  assert.equal((await worker.processPending({ transport })).processed, 0);
  assert.equal(attempts, 1);
});

test("restart detects expired sending claims without risking duplicate SMTP delivery", async (t) => {
  const row = emailRow({
    error_message: JSON.stringify({
      state: "sending",
      attempts: 1,
      claimed_at: "2026-11-05T00:00:00.000Z",
      claim: "previous-process-claim",
    }),
  });
  mockQueue(t, row);
  const transport = {
    sendMail: async () =>
      assert.fail("Unknown previous process outcome must not be resent"),
  };
  assert.equal(
    (
      await worker.processPending({
        transport,
        now: new Date("2026-11-05T00:01:00Z"),
      })
    ).processed,
    0,
  );
  assert.equal(
    (
      await worker.processPending({
        transport,
        now: new Date("2026-11-05T00:02:01Z"),
      })
    ).ambiguous,
    1,
  );
  assert.equal(
    service.metadata(row.error_message).reason,
    "smtp_claim_expired",
  );
});

test("disabled SMTP, simulation and revoked recipients fail closed without invoking transport", async (t) => {
  const row = emailRow();
  mockQueue(t, row);
  const transport = {
    sendMail: async () => assert.fail("Suppressed email must not reach SMTP"),
  };
  t.mock.method(mailer, "configuration", () => ({
    enabled: false,
    configured: true,
  }));
  assert.equal((await worker.processPending({ transport })).failed, 1);
  assert.equal(service.metadata(row.error_message).reason, "email_disabled");
  assert.equal(service.metadata(row.error_message).attempts, 0);
  Object.assign(row, emailRow({ source: "simulation" }));
  assert.equal((await worker.processPending({ transport })).failed, 1);
  assert.equal(
    service.metadata(row.error_message).reason,
    "simulation_suppressed",
  );
  Object.assign(row, emailRow({ recipient_role: "viewer" }));
  assert.equal((await worker.processPending({ transport })).failed, 1);
  assert.equal(
    service.metadata(row.error_message).reason,
    "recipient_access_revoked",
  );
});

test("concurrent worker ticks cannot send the same pending item twice", async (t) => {
  const row = emailRow();
  mockQueue(t, row);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let started;
  const reached = new Promise((resolve) => {
    started = resolve;
  });
  let attempts = 0;
  const transport = {
    sendMail: async () => {
      attempts++;
      started();
      await gate;
      return { accepted: [row.email] };
    },
  };
  const first = worker.processPending({ transport });
  await reached;
  assert.deepEqual(await worker.processPending({ transport }), { busy: true });
  release();
  assert.equal((await first).sent, 1);
  assert.equal(attempts, 1);
});

test("email text has local time, uncertainty and a dashboard link with no secret URL query", () => {
  const previous = process.env.WEB_DASHBOARD_URL;
  process.env.WEB_DASHBOARD_URL =
    "https://dashboard.example.invalid?jwt=private#private";
  try {
    const message = mailer.message(
      emailRow({ title: "Warning\r\nInjected-Header" }),
    );
    assert.equal(message.subject.includes("\n"), false);
    assert.equal(message.text.includes("Asia/Makassar"), true);
    assert.equal(
      message.text.includes(
        "https://dashboard.example.invalid/dashboard?coop_id=4",
      ),
      true,
    );
    assert.equal(message.text.includes("private"), false);
    assert.equal(message.text.includes("SMTP_PASS"), false);
  } finally {
    if (previous === undefined) delete process.env.WEB_DASHBOARD_URL;
    else process.env.WEB_DASHBOARD_URL = previous;
  }
});
