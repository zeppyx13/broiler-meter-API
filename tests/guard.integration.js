require("dotenv").config({ quiet: true });
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const express = require("express");
const jwt = require("jsonwebtoken");
if (
  process.env.NODE_ENV === "production" ||
  process.env.DB_NAME !== "coasther_broiler"
)
  throw new Error("Guard tests require imported development coasther_broiler");
process.env.NODE_ENV = "test";
process.env.JWT_SECRET ||= crypto.randomBytes(32).toString("hex");
const db = require("../src/config/db");
const guard = require("../src/services/guard.service");
const model = require("../src/models/guard.model");
const notifications = require("../src/services/notificationBroiler.service");
const logger = require("../src/config/logger");
for (const transport of logger.transports) transport.silent = true;

test(
  "Guard HTTP, deterministic windows, concurrent episodes and simulated watchdog on isolated fixtures",
  { timeout: 60000 },
  async (t) => {
    const marker = `guard-test-${crypto.randomUUID()}`;
    const userIds = [];
    const baseTime = Math.floor(Date.now() / 1000) * 1000 - 600000;
    const instant = (seconds) => new Date(baseTime + seconds * 1000);
    let farmId, coopId, deviceId, server, base;
    let manager, operator, viewer, outsider;
    const active = new Set();
    let projecting = 0;
    const originalRules = model.rules;
    // Persisted rules remain disabled so the separately running owner's watchdog cannot process these fixtures.
    t.mock.method(model, "rules", async (id, connection) => {
      const rows = await originalRules(id, connection);
      return String(id) === String(coopId) && projecting
        ? rows.map((row) => ({ ...row, is_active: active.has(row.id) ? 1 : 0 }))
        : rows;
    });
    async function project(work) {
      projecting++;
      try {
        return await work();
      } finally {
        projecting--;
      }
    }
    async function account(role) {
      const [result] = await db.query(
        "INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?,?)",
        [
          marker,
          `${marker}-${role}-${userIds.length}@example.invalid`,
          "!unusable-guard-fixture-hash",
          role,
        ],
      );
      userIds.push(result.insertId);
      return {
        id: result.insertId,
        role,
        token: jwt.sign({ id: result.insertId, role }, process.env.JWT_SECRET),
      };
    }
    async function request(method, path, user, body, expected = 200) {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: {
          ...(user ? { Authorization: `Bearer ${user.token}` } : {}),
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const output = await response.json();
      assert.equal(
        response.status,
        expected,
        `${method} ${path}: ${JSON.stringify(output)}`,
      );
      return output.data;
    }
    async function rule(code, parameters, extra = {}) {
      const result = await request(
        "POST",
        "/api/alert-rules",
        manager,
        {
          coop_id: coopId,
          rule_code: code,
          name: marker,
          evaluation_window_sec: 10,
          cooldown_sec: 20,
          parameters_json: parameters,
          is_active: false,
          ...extra,
        },
        201,
      );
      return result.rule;
    }
    async function snapshot(seconds, { power = 5, flow = 10 } = {}) {
      const at = instant(seconds);
      await db.query(
        `INSERT INTO coop_live_status (coop_id,device_id,power_w,voltage_v,flow_rate_lpm,source,recorded_at,phase_data_json)
       VALUES (?,?,?,?,?,'simulation',?,?) ON DUPLICATE KEY UPDATE power_w=VALUES(power_w),voltage_v=VALUES(voltage_v),
       flow_rate_lpm=VALUES(flow_rate_lpm),source=VALUES(source),recorded_at=VALUES(recorded_at),phase_data_json=VALUES(phase_data_json)`,
        [
          coopId,
          deviceId,
          power,
          220,
          flow,
          at,
          JSON.stringify({
            metric_recorded_at: {
              power_w: at.toISOString(),
              voltage_v: at.toISOString(),
              flow_rate_lpm: at.toISOString(),
            },
            metric_device_id: {
              power_w: deviceId,
              voltage_v: deviceId,
              flow_rate_lpm: deviceId,
            },
          }),
        ],
      );
    }
    async function evaluate(seconds, values, source = "simulation") {
      if (values) await snapshot(seconds, values);
      return project(() =>
        guard.evaluateCoop(coopId, { source, now: instant(seconds) }),
      );
    }
    async function alertRows(ruleId) {
      const [rows] = await db.query(
        "SELECT * FROM alerts WHERE coop_id=? AND alert_rule_id=? ORDER BY id",
        [coopId, ruleId],
      );
      return rows;
    }
    try {
      manager = await account("manager");
      operator = await account("operator");
      viewer = await account("operator");
      outsider = await account("operator");
      const [farm] = await db.query(
        "INSERT INTO farms (owner_user_id,name) VALUES (?,?)",
        [manager.id, marker],
      );
      farmId = farm.insertId;
      for (const [user, role] of [
        [manager, "owner"],
        [operator, "operator"],
        [viewer, "viewer"],
      ])
        await db.query(
          "INSERT INTO farm_members (farm_id,user_id,role) VALUES (?,?,?)",
          [farmId, user.id, role],
        );
      const [coop] = await db.query(
        "INSERT INTO coops (farm_id,code,name) VALUES (?,?,?)",
        [farmId, "GUARD-01", marker],
      );
      coopId = coop.insertId;
      const [device] = await db.query(
        "INSERT INTO devices (coop_id,device_uid,mqtt_topic_key,name,last_seen_at) VALUES (?,?,?,?,?)",
        [coopId, marker, marker, marker, instant(0)],
      );
      deviceId = device.insertId;
      const app = express();
      app.use(express.json());
      const routes = require("../src/routes/guard.routes");
      app.use("/api/alert-rules", routes.rulesRouter);
      app.use("/api/alerts", routes.alertsRouter);
      app.use("/api/guard", routes.statusRouter);
      app.use(require("../src/middlewares/error.middleware"));
      server = app.listen(0, "127.0.0.1");
      await new Promise((resolve) => server.once("listening", resolve));
      base = `http://127.0.0.1:${server.address().port}`;
      let powerRule, waterRule, offlineRule;

      await t.test(
        "rule HTTP validates payload, owner/manager permissions, and cross-farm reads",
        async () => {
          await request(
            "GET",
            `/api/alert-rules?coop_id=${coopId}`,
            null,
            undefined,
            401,
          );
          await request(
            "POST",
            "/api/alert-rules",
            operator,
            {
              coop_id: coopId,
              rule_code: "device_offline",
              name: marker,
              parameters_json: {},
              is_active: false,
            },
            403,
          );
          await request(
            "GET",
            `/api/alert-rules?coop_id=${coopId}`,
            outsider,
            undefined,
            403,
          );
          powerRule = await rule("suspected_power_anomaly", {
            min_power_w: 10,
            recovery_power_w: 15,
            recovery_window_sec: 10,
          });
          waterRule = await rule("suspected_water_anomaly", {
            max_flow_lpm: 8,
            recovery_flow_lpm: 3,
            recovery_window_sec: 10,
          });
          offlineRule = await rule("device_offline", {
            stale_after_seconds: 30,
            recovery_window_sec: 10,
            device_id: deviceId,
          });
          const noFlow = await rule("no_water_flow", {});
          await request(
            "PATCH",
            `/api/alert-rules/${noFlow.id}`,
            manager,
            { is_active: true },
            400,
          );
          await request(
            "PATCH",
            `/api/alert-rules/${powerRule.id}`,
            viewer,
            { name: "Unauthorized" },
            403,
          );
          await request("PATCH", `/api/alert-rules/${powerRule.id}`, manager, {
            name: "Configured low panel load",
            is_active: false,
          });
          const list = await request(
            "GET",
            `/api/alert-rules?coop_id=${coopId}`,
            viewer,
          );
          assert.equal(list.rules.length, 4);
          assert.ok(list.rules.every((row) => row.is_active === false));
          assert.ok(
            list.rules.every(
              (row) => row.evaluation.status === "not_evaluated",
            ),
          );
        },
      );

      await t.test(
        "power window creates one concurrent episode and one notification per eligible channel/recipient",
        async () => {
          active.clear();
          active.add(powerRule.id);
          await evaluate(0, { power: 5 });
          await evaluate(5, { power: 5 });
          await snapshot(10, { power: 5 });
          const concurrent = await project(() =>
            Promise.allSettled([
              guard.evaluateCoop(coopId, {
                source: "simulation",
                now: instant(10),
              }),
              guard.evaluateCoop(coopId, {
                source: "simulation",
                now: instant(10),
              }),
            ]),
          );
          for (const result of concurrent)
            if (result.status === "rejected") throw result.reason;
          const rows = await alertRows(powerRule.id);
          assert.equal(rows.length, 1);
          assert.equal(rows[0].source, "simulation");
          assert.equal(rows[0].status, "active");
          const [notices] = await db.query(
            "SELECT user_id,channel,delivery_status FROM notifications WHERE alert_id=?",
            [rows[0].id],
          );
          assert.equal(notices.length, 4);
          assert.ok(
            notices.every((notice) =>
              [manager.id, operator.id].includes(notice.user_id),
            ),
          );
          assert.ok(
            notices
              .filter((notice) => notice.channel === "email")
              .every((notice) => notice.delivery_status === "failed"),
          );
          await evaluate(15, { power: 5 });
          assert.equal((await alertRows(powerRule.id)).length, 1);
          const status = await request(
            "GET",
            `/api/guard/status?coop_id=${coopId}&source=simulation`,
            viewer,
          );
          assert.equal(
            status.evaluations.find((row) => row.rule_id === powerRule.id)
              .status,
            "trigger",
          );
          const real = await evaluate(15, undefined, "rule");
          assert.ok(
            real.evaluations
              .filter((row) => row.rule_id === powerRule.id)
              .every((row) => row.status === "insufficient_data"),
          );
        },
      );

      await t.test(
        "hysteresis resolves after full recovery and cooldown controls a new episode",
        async () => {
          await evaluate(20, { power: 20 });
          await evaluate(25, { power: 20 });
          assert.equal((await alertRows(powerRule.id))[0].status, "active");
          await evaluate(30, { power: 20 });
          assert.equal((await alertRows(powerRule.id))[0].status, "resolved");
          for (const seconds of [35, 40, 45])
            await evaluate(seconds, { power: 5 });
          assert.equal((await alertRows(powerRule.id)).length, 1);
          await evaluate(50, { power: 5 });
          assert.equal((await alertRows(powerRule.id)).length, 2);
        },
      );

      await t.test(
        "alerts filter provenance and ack/resolve preserve role boundaries and audit",
        async () => {
          active.clear();
          active.add(waterRule.id);
          for (const seconds of [60, 65, 70])
            await evaluate(seconds, { flow: 10 });
          const alert = (await alertRows(waterRule.id))[0];
          await request(
            "GET",
            `/api/alerts/${alert.id}`,
            outsider,
            undefined,
            403,
          );
          assert.equal(
            (await request("GET", `/api/alerts?coop_id=${coopId}`, manager))
              .alerts.length,
            0,
          );
          const filtered = await request(
            "GET",
            `/api/alerts?coop_id=${coopId}&source=simulation&status=active&severity=warning`,
            viewer,
          );
          assert.ok(filtered.alerts.some((row) => row.id === alert.id));
          await request(
            "PATCH",
            `/api/alerts/${alert.id}/ack`,
            viewer,
            {},
            403,
          );
          const acknowledged = await request(
            "PATCH",
            `/api/alerts/${alert.id}/ack`,
            operator,
            {},
          );
          assert.equal(acknowledged.alert.status, "acknowledged");
          assert.equal(acknowledged.alert.acknowledged_by, operator.id);
          await request(
            "PATCH",
            `/api/alerts/${alert.id}/resolve`,
            operator,
            { note: "Operator observed tank state" },
            403,
          );
          const resolved = await request(
            "PATCH",
            `/api/alerts/${alert.id}/resolve`,
            manager,
            { note: "Operator inspected tank and corrected filling context" },
          );
          assert.equal(resolved.alert.status, "resolved");
          assert.equal(
            resolved.alert.evidence_json.resolution.user_id,
            manager.id,
          );
        },
      );

      await t.test(
        "watchdog evaluates without incoming telemetry and resolves after trusted receipt recovery",
        async (subtest) => {
          active.clear();
          active.add(offlineRule.id);
          subtest.mock.method(model, "watchdogCoops", async () => [
            { id: coopId },
          ]);
          const result = await project(() =>
            guard.watchdog({ source: "simulation", now: instant(100) }),
          );
          assert.equal(result.failed_coops, 0);
          assert.equal(result.evaluated_coops, 1);
          assert.equal((await alertRows(offlineRule.id))[0].status, "active");
          for (const seconds of [110, 120]) {
            await db.query(
              "UPDATE devices SET last_seen_at=? WHERE id=? AND device_uid=?",
              [instant(seconds), deviceId, marker],
            );
            await project(() =>
              guard.watchdog({ source: "simulation", now: instant(seconds) }),
            );
          }
          assert.equal((await alertRows(offlineRule.id))[0].status, "resolved");
        },
      );

      await t.test(
        "notification persistence failure rolls back a new alert and a later evaluation recovers",
        async (subtest) => {
          active.clear();
          active.add(powerRule.id);
          const previous = (await alertRows(powerRule.id)).at(-1);
          await guard.resolve(
            manager,
            previous.id,
            "Fixture reset between independently simulated episodes",
            { now: instant(150) },
          );
          await evaluate(200, { power: 5 });
          await evaluate(205, { power: 5 });
          const count = (await alertRows(powerRule.id)).length;
          const original = notifications.createForAlert;
          const failure = subtest.mock.method(
            notifications,
            "createForAlert",
            async () => {
              throw new Error("Injected notification persistence failure");
            },
          );
          await assert.rejects(
            evaluate(210, { power: 5 }),
            /Injected notification persistence failure/,
          );
          assert.equal((await alertRows(powerRule.id)).length, count);
          failure.mock.restore();
          assert.equal(notifications.createForAlert, original);
          await evaluate(215, { power: 5 });
          assert.equal((await alertRows(powerRule.id)).length, count + 1);
        },
      );

      const [[{ count }]] = await db.query(
        "SELECT COUNT(*) AS count FROM alerts WHERE coop_id=? AND source<>'simulation'",
        [coopId],
      );
      assert.equal(count, 0);
      const [[{ enabled }]] = await db.query(
        "SELECT COUNT(*) AS enabled FROM alert_rules WHERE coop_id=? AND is_active=1",
        [coopId],
      );
      assert.equal(enabled, 0);
    } finally {
      await guard.flushEffects();
      if (server) await new Promise((resolve) => server.close(resolve));
      if (coopId) {
        // Select fixture ownership without locks; delete exact PKs with separate autocommit statements.
        // Joined/range deletes can lock unrelated records and FK gaps while other domain suites run.
        const [notices] = await db.query(
          "SELECT n.id,n.alert_id FROM notifications n JOIN alerts a ON a.id=n.alert_id WHERE a.coop_id=?",
          [coopId],
        );
        const [alerts] = await db.query(
          "SELECT id FROM alerts WHERE coop_id=?",
          [coopId],
        );
        const [rules] = await db.query(
          "SELECT id FROM alert_rules WHERE coop_id=?",
          [coopId],
        );
        for (const row of notices)
          await db.query(
            "DELETE FROM notifications WHERE id=? AND alert_id=?",
            [row.id, row.alert_id],
          );
        for (const row of alerts)
          await db.query("DELETE FROM alerts WHERE id=? AND coop_id=?", [
            row.id,
            coopId,
          ]);
        for (const row of rules)
          await db.query("DELETE FROM alert_rules WHERE id=? AND coop_id=?", [
            row.id,
            coopId,
          ]);
        await db.query(
          "DELETE FROM coop_live_status WHERE coop_id=? AND source='simulation'",
          [coopId],
        );
        if (deviceId)
          await db.query("DELETE FROM devices WHERE id=? AND device_uid=?", [
            deviceId,
            marker,
          ]);
        await db.query("DELETE FROM coops WHERE id=? AND name=?", [
          coopId,
          marker,
        ]);
      }
      if (farmId) {
        const [members] = await db.query(
          "SELECT id FROM farm_members WHERE farm_id=?",
          [farmId],
        );
        for (const row of members)
          await db.query("DELETE FROM farm_members WHERE id=? AND farm_id=?", [
            row.id,
            farmId,
          ]);
        await db.query("DELETE FROM farms WHERE id=? AND name=?", [
          farmId,
          marker,
        ]);
      }
      for (const id of userIds)
        await db.query("DELETE FROM users WHERE id=? AND name=?", [id, marker]);
      await db.end();
    }
  },
);
