require("dotenv").config({ quiet: true });
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const bcrypt = require("bcryptjs");

if (
  process.env.NODE_ENV === "production" ||
  process.env.DB_NAME !== "coasther_broiler"
) {
  throw new Error(
    "Notification integration requires the imported development coasther_broiler database",
  );
}
process.env.NODE_ENV = "test";
process.env.BROILER_EMAIL_ENABLED = "false";
const db = require("../src/config/db");
const users = require("../src/models/user.model");
const farms = require("../src/services/farm.service");
const farmSchema = require("../src/validators/farm.validator");
const coops = require("../src/services/coop.service");
const coopSchema = require("../src/validators/coop.validator");
const access = require("../src/services/access.service");
const withTransaction = require("../src/utils/transaction");
const notifications = require("../src/services/notificationBroiler.service");
const querySchema =
  require("../src/validators/notificationBroiler.validator").querySchema;
const emailModel = require("../src/models/notificationEmailBroiler.model");
const emailWorker = require("../src/services/notificationEmailBroiler.service");
const { verify } = require("../src/services/schemaCompatibility.service");

test(
  "notification recipients, inbox ownership and simulation delivery audit on imported development DB",
  { timeout: 30000 },
  async (t) => {
    const marker = `notify-test-${crypto.randomUUID()}`;
    const userIds = [];
    const farmIds = [];
    let owner, operator, viewer, outsider, farm, coop, episode, second;

    async function account(label, role) {
      const id = await users.createUser({
        name: `${marker}-${label}`,
        email: `${marker}-${label}@example.invalid`,
        password_hash: await bcrypt.hash(
          crypto.randomBytes(16).toString("hex"),
          4,
        ),
        role,
      });
      userIds.push(id);
      return users.findById(id);
    }

    async function createEpisode(subject, severity = "warning") {
      return withTransaction(async (connection) => {
        await access.lockCoop(connection, subject.id);
        const [result] = await connection.query(
          `INSERT INTO alerts (coop_id, alert_type, severity, title, message, evidence_json, dedupe_key, source, detected_at)
         VALUES (?, 'suspected_power_anomaly', ?, ?, ?, ?, ?, 'simulation', ?)`,
          [
            subject.id,
            severity,
            `${marker} suspected panel anomaly`,
            "SIMULATION: deterministic indication only",
            JSON.stringify({ source: "simulation", measurement: "synthetic" }),
            `${marker}-${crypto.randomUUID()}`,
            new Date(),
          ],
        );
        const alert = { id: result.insertId, coop_id: subject.id };
        const rows = await notifications.createForAlert(
          connection,
          alert,
          subject,
        );
        const repeated = await notifications.createForAlert(
          connection,
          alert,
          subject,
        );
        assert.equal(repeated.length, 0);
        return { alert, rows };
      });
    }

    async function cleanup() {
      // Discover only this run's descendants with nonlocking reads before starting deletion.
      // Joined DELETE plans can otherwise lock unrelated fixture parents/index gaps.
      const [ownedUsers] = userIds.length
        ? await db.query(
            "SELECT id FROM users WHERE id IN (?) AND name LIKE ? ORDER BY id",
            [userIds, `${marker}%`],
          )
        : [[]];
      const ownUserIds = ownedUsers.map((row) => row.id);
      const [ownedFarms] =
        farmIds.length && ownUserIds.length
          ? await db.query(
              "SELECT id FROM farms WHERE id IN (?) AND owner_user_id IN (?) AND name LIKE ? ORDER BY id",
              [farmIds, ownUserIds, `${marker}%`],
            )
          : [[]];
      const ownFarmIds = ownedFarms.map((row) => row.id);
      const [ownedCoops] = ownFarmIds.length
        ? await db.query(
            "SELECT id FROM coops WHERE farm_id IN (?) ORDER BY id",
            [ownFarmIds],
          )
        : [[]];
      const coopIds = ownedCoops.map((row) => row.id);
      const [ownedAlerts] = coopIds.length
        ? await db.query(
            "SELECT id FROM alerts WHERE coop_id IN (?) ORDER BY id",
            [coopIds],
          )
        : [[]];
      const alertIds = ownedAlerts.map((row) => row.id);
      const [ownedNotifications] = alertIds.length
        ? await db.query(
            "SELECT id FROM notifications WHERE alert_id IN (?) ORDER BY id",
            [alertIds],
          )
        : [[]];
      const notificationIds = ownedNotifications.map((row) => row.id);
      const [ownedMembers] = ownFarmIds.length
        ? await db.query(
            "SELECT id FROM farm_members WHERE farm_id IN (?) ORDER BY id",
            [ownFarmIds],
          )
        : [[]];
      const memberIds = ownedMembers.map((row) => row.id);
      const connection = await db.getConnection();
      try {
        await connection.beginTransaction();
        if (notificationIds.length)
          await connection.query("DELETE FROM notifications WHERE id IN (?)", [
            notificationIds,
          ]);
        if (alertIds.length)
          await connection.query("DELETE FROM alerts WHERE id IN (?)", [
            alertIds,
          ]);
        if (ownUserIds.length)
          await connection.query(
            "UPDATE users SET default_coop_id = NULL WHERE id IN (?)",
            [ownUserIds],
          );
        if (coopIds.length)
          await connection.query("DELETE FROM coops WHERE id IN (?)", [
            coopIds,
          ]);
        if (memberIds.length)
          await connection.query("DELETE FROM farm_members WHERE id IN (?)", [
            memberIds,
          ]);
        if (ownFarmIds.length)
          await connection.query("DELETE FROM farms WHERE id IN (?)", [
            ownFarmIds,
          ]);
        if (ownUserIds.length)
          await connection.query("DELETE FROM users WHERE id IN (?)", [
            ownUserIds,
          ]);
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
    }

    try {
      assert.equal((await verify()).verified_tables, 21);
      owner = await account("owner", "manager");
      operator = await account("operator", "operator");
      viewer = await account("viewer", "operator");
      outsider = await account("outsider", "admin");
      farm = (
        await farms.create(
          owner,
          farmSchema.createSchema.parse({ name: marker }),
        )
      ).farm;
      farmIds.push(farm.id);
      await farms.changeMember(owner, farm.id, operator.id, "operator", "add");
      await farms.changeMember(owner, farm.id, viewer.id, "viewer", "add");
      coop = (
        await coops.create(
          owner,
          coopSchema.createSchema.parse({
            farm_id: farm.id,
            code: "N1",
            name: "Synthetic notifications coop",
          }),
        )
      ).coop;

      await t.test(
        "new simulated episode creates one web and email audit per owner/operator, never viewer/global outsiders",
        async () => {
          episode = await createEpisode(coop);
          assert.equal(episode.rows.length, 4);
          assert.deepEqual(
            [...new Set(episode.rows.map((row) => row.user_id))].sort(),
            [owner.id, operator.id].sort(),
          );
          assert.equal(
            episode.rows.every((row) => row.source === "simulation"),
            true,
          );
          assert.equal(
            episode.rows.some((row) => row.channel === "fcm"),
            false,
          );
          const web = episode.rows.filter((row) => row.channel === "in_app");
          assert.equal(
            web.every(
              (row) =>
                row.delivery_status === "sent" &&
                row.sent_at &&
                row.read_at == null,
            ),
            true,
          );
          const email = episode.rows.filter((row) => row.channel === "email");
          assert.equal(
            email.every(
              (row) =>
                row.delivery_status === "failed" &&
                notifications.metadata(row.error_message).reason ===
                  "simulation_suppressed",
            ),
            true,
          );
        },
      );

      await t.test(
        "inbox pagination, channel audit, unread count and idempotent mark-read respect user ownership",
        async () => {
          const query = querySchema.parse({ page: "1", limit: "1" });
          const inbox = await notifications.list(operator, query);
          assert.equal(inbox.notifications.length, 1);
          assert.equal(inbox.meta.total, 1);
          assert.equal(inbox.unread_count, 1);
          assert.equal(
            (await notifications.list(viewer, query)).notifications.length,
            0,
          );
          assert.equal(
            (await notifications.list(outsider, query)).notifications.length,
            0,
          );
          const emailAudit = await notifications.list(
            operator,
            querySchema.parse({ channel: "email" }),
          );
          assert.equal(
            emailAudit.notifications[0].error_message,
            "simulation_suppressed",
          );
          const ownId = inbox.notifications[0].id;
          const ownerId = episode.rows.find(
            (row) => row.user_id === owner.id && row.channel === "in_app",
          ).id;
          await assert.rejects(notifications.read(operator, ownerId), {
            statusCode: 404,
          });
          const first = await notifications.read(operator, ownId);
          const again = await notifications.read(operator, ownId);
          assert.equal(
            first.notification.read_at.getTime(),
            again.notification.read_at.getTime(),
          );
          assert.equal(again.unread_count, 0);
        },
      );

      await t.test(
        "info episodes remain web-only and mark-all-read updates only the caller inbox",
        async () => {
          second = await createEpisode(coop, "info");
          assert.equal(second.rows.length, 2);
          assert.equal(
            second.rows.every((row) => row.channel === "in_app"),
            true,
          );
          assert.equal(
            (await notifications.unread(operator, {})).unread_count,
            1,
          );
          const result = await notifications.readAll(operator, {});
          assert.equal(result.updated, 1);
          assert.equal(result.unread_count, 0);
          assert.equal((await notifications.unread(owner, {})).unread_count, 2);
        },
      );

      await t.test(
        "downgraded and revoked recipients cannot retrieve or mark historical inbox rows",
        async () => {
          const id = episode.rows.find(
            (row) => row.user_id === operator.id && row.channel === "in_app",
          ).id;
          await farms.changeMember(
            owner,
            farm.id,
            operator.id,
            "viewer",
            "update",
          );
          assert.equal(
            (await notifications.list(operator, querySchema.parse({})))
              .notifications.length,
            0,
          );
          await assert.rejects(notifications.read(operator, id), {
            statusCode: 403,
          });
          await farms.changeMember(owner, farm.id, operator.id, null, "remove");
          assert.equal(
            (await notifications.unread(operator, {})).unread_count,
            0,
          );
          await assert.rejects(notifications.read(operator, id), {
            statusCode: 403,
          });
        },
      );

      await t.test(
        "a pending simulation email fails closed even if manually requeued, without SMTP or changes to other pending records",
        async (subtest) => {
          const row = episode.rows.find(
            (item) => item.user_id === owner.id && item.channel === "email",
          );
          await db.query(
            "UPDATE notifications SET delivery_status = 'pending', error_message = ? WHERE id = ? AND user_id = ?",
            [
              JSON.stringify({ state: "queued", attempts: 0 }),
              row.id,
              owner.id,
            ],
          );
          // This test must never process any real alert's pending mail on the shared development DB.
          subtest.mock.method(emailModel, "candidates", async () => [
            { id: row.id, coop_id: coop.id },
          ]);
          const transport = {
            sendMail: async () => assert.fail("Simulation reached SMTP"),
          };
          const result = await emailWorker.processPending({ transport });
          assert.equal(result.failed, 1);
          const [[stored]] = await db.query(
            "SELECT delivery_status, error_message, sent_at FROM notifications WHERE id = ?",
            [row.id],
          );
          assert.equal(stored.delivery_status, "failed");
          assert.equal(
            notifications.metadata(stored.error_message).reason,
            "simulation_suppressed",
          );
          assert.equal(stored.sent_at, null);
        },
      );

      await t.test(
        "simultaneous new episodes on different farms avoid notification empty-gap deadlocks",
        async () => {
          const otherFarm = (
            await farms.create(
              owner,
              farmSchema.createSchema.parse({ name: `${marker}-second` }),
            )
          ).farm;
          farmIds.push(otherFarm.id);
          const otherCoop = (
            await coops.create(
              owner,
              coopSchema.createSchema.parse({
                farm_id: otherFarm.id,
                code: "N2",
                name: "Second test coop",
              }),
            )
          ).coop;
          const results = await Promise.all([
            createEpisode(coop),
            createEpisode(otherCoop),
          ]);
          assert.equal(results[0].rows.length, 2);
          assert.equal(results[1].rows.length, 2);
        },
      );
    } finally {
      try {
        await cleanup();
      } finally {
        await db.end();
      }
    }
  },
);
