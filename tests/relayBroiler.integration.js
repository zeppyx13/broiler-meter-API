require("dotenv").config({ quiet: true });
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const express = require("express");

if (
  process.env.NODE_ENV === "production" ||
  process.env.DB_NAME !== "coasther_broiler"
) {
  throw new Error(
    "Relay integration tests require the imported development coasther_broiler database",
  );
}
process.env.NODE_ENV = "test";
process.env.JWT_SECRET ||= crypto.randomBytes(32).toString("hex");
const oldCommandToken = process.env.MQTT_CMD_TOKEN;
process.env.MQTT_CMD_TOKEN = crypto.randomBytes(24).toString("hex");
const db = require("../src/config/db");
const userModel = require("../src/models/user.model");
const farms = require("../src/models/farm.model");
const coops = require("../src/models/coop.model");
const devices = require("../src/models/device.model");
const model = require("../src/models/relayBroiler.model");
const service = require("../src/services/relayBroiler.service");
const { verify } = require("../src/services/schemaCompatibility.service");

test(
  "relay APIs, audit and synthetic state observations on isolated development fixtures with a broker mock",
  { timeout: 30000 },
  async (t) => {
    const marker = `relay-test-${crypto.randomUUID()}`;
    const owned = { users: [], farms: [], coops: [], devices: [] };
    const app = express();
    app.use(express.json());
    app.use("/api/relays", require("../src/routes/relayBroiler.routes"));
    app.use(require("../src/middlewares/error.middleware"));
    let server;
    let base;
    let owner,
      operator,
      outsider,
      firstDevice,
      secondDevice,
      firstRelay,
      secondRelay;
    const publications = [];
    const client = {
      connected: true,
      options: { queueQoSZero: false },
      publish(topic, payload, options, callback) {
        assert.equal(payload.endsWith(`:${process.env.MQTT_CMD_TOKEN}`), true);
        assert.deepEqual(options, { qos: 0, retain: false });
        publications.push({ topic, command: payload.split(":")[0] });
        callback();
      },
    };
    service.configure({ client });

    async function request(method, path, actor, body, expected = 200) {
      const response = await fetch(`${base}/api/relays${path}`, {
        method,
        headers: {
          ...(actor ? { Authorization: `Bearer ${actor.token}` } : {}),
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const value = await response.json();
      assert.equal(
        response.status,
        expected,
        `${method} ${path}: ${JSON.stringify(value)}`,
      );
      assert.equal(
        JSON.stringify(value).includes(process.env.MQTT_CMD_TOKEN),
        false,
      );
      return value;
    }

    async function account(label, role) {
      const id = await userModel.createUser({
        name: label,
        email: `${marker}-${label}@example.invalid`,
        role,
        password_hash: await bcrypt.hash(
          crypto.randomBytes(20).toString("hex"),
          4,
        ),
      });
      owned.users.push(id);
      return {
        id,
        role,
        token: jwt.sign({ id, role }, process.env.JWT_SECRET, {
          expiresIn: "1h",
        }),
      };
    }

    async function fixtureDevice(label) {
      const connection = await db.getConnection();
      try {
        await connection.beginTransaction();
        const farmId = await farms.create(
          owner.id,
          {
            name: `${marker}-${label}`,
            location_text: "Isolated test fixture",
            timezone: "Asia/Makassar",
            electricity_rate_idr_per_kwh: 0,
            water_rate_idr_per_m3: 0,
          },
          connection,
        );
        owned.farms.push(farmId);
        await farms.addMember(farmId, owner.id, "owner", connection);
        await farms.addMember(farmId, operator.id, "operator", connection);
        const coopId = await coops.create(
          {
            farm_id: farmId,
            code: label,
            name: label,
            capacity_birds: 100,
            description: null,
            status: "active",
          },
          connection,
        );
        owned.coops.push(coopId);
        const deviceId = await devices.create(
          {
            coop_id: coopId,
            device_uid: `${marker}-${label}`,
            mqtt_topic_key: `${marker}-${label}`,
            name: label,
            device_type: "esp32",
            firmware_version: "3.1",
            is_active: true,
          },
          connection,
        );
        owned.devices.push(deviceId);
        // A synthetic fixture heartbeat, not a real sensor reading or a real paired device.
        await connection.query(
          "UPDATE devices SET last_seen_at = UTC_TIMESTAMP(), connectivity_status = 'online' WHERE id = ?",
          [deviceId],
        );
        await connection.commit();
        return {
          id: deviceId,
          coop_id: coopId,
          topic_key: `${marker}-${label}`,
        };
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
    }

    async function cleanup() {
      const connection = await db.getConnection();
      try {
        // Discover fixture primary keys in autocommit reads before taking any write locks.
        // Foreign-key range/joined deletes can otherwise lock unrelated parallel suites' gaps.
        const [relayRows] = owned.devices.length
          ? await connection.query(
              "SELECT id FROM relays WHERE device_id IN (?)",
              [owned.devices],
            )
          : [[]];
        const relayIds = relayRows.map((row) => row.id);
        const [commandRows] = relayIds.length
          ? await connection.query(
              "SELECT id FROM relay_commands WHERE relay_id IN (?)",
              [relayIds],
            )
          : [[]];
        const [deviceRows] = owned.devices.length
          ? await connection.query("SELECT id FROM devices WHERE id IN (?)", [
              owned.devices,
            ])
          : [[]];
        const [coopRows] = owned.coops.length
          ? await connection.query("SELECT id FROM coops WHERE id IN (?)", [
              owned.coops,
            ])
          : [[]];
        const [memberRows] = owned.farms.length
          ? await connection.query(
              "SELECT id FROM farm_members WHERE farm_id IN (?)",
              [owned.farms],
            )
          : [[]];
        const [farmRows] = owned.farms.length
          ? await connection.query("SELECT id FROM farms WHERE id IN (?)", [
              owned.farms,
            ])
          : [[]];
        const [userRows] = owned.users.length
          ? await connection.query("SELECT id FROM users WHERE id IN (?)", [
              owned.users,
            ])
          : [[]];
        const commandIds = commandRows.map((row) => row.id);
        const deviceIds = deviceRows.map((row) => row.id);
        const coopIds = coopRows.map((row) => row.id);
        const memberIds = memberRows.map((row) => row.id);
        const farmIds = farmRows.map((row) => row.id);
        const userIds = userRows.map((row) => row.id);
        await connection.beginTransaction();
        if (commandIds.length)
          await connection.query("DELETE FROM relay_commands WHERE id IN (?)", [
            commandIds,
          ]);
        if (relayIds.length)
          await connection.query("DELETE FROM relays WHERE id IN (?)", [
            relayIds,
          ]);
        if (deviceIds.length)
          await connection.query("DELETE FROM devices WHERE id IN (?)", [
            deviceIds,
          ]);
        if (userIds.length)
          await connection.query(
            "UPDATE users SET default_coop_id = NULL WHERE id IN (?)",
            [userIds],
          );
        if (coopIds.length)
          await connection.query("DELETE FROM coops WHERE id IN (?)", [
            coopIds,
          ]);
        if (memberIds.length)
          await connection.query("DELETE FROM farm_members WHERE id IN (?)", [
            memberIds,
          ]);
        if (farmIds.length)
          await connection.query("DELETE FROM farms WHERE id IN (?)", [
            farmIds,
          ]);
        if (userIds.length)
          await connection.query("DELETE FROM users WHERE id IN (?)", [
            userIds,
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
      await verify();
      owner = await account("owner", "manager");
      operator = await account("operator", "operator");
      outsider = await account("outsider", "manager");
      firstDevice = await fixtureDevice("a");
      secondDevice = await fixtureDevice("b");
      server = app.listen(0, "127.0.0.1");
      await new Promise((resolve) => server.once("listening", resolve));
      base = `http://127.0.0.1:${server.address().port}`;

      await t.test(
        "pairing, CRUD and read access follow farm roles and the physical single-channel contract",
        async () => {
          await request("GET", "", null, null, 401);
          await request(
            "POST",
            "",
            operator,
            { device_id: firstDevice.id, name: "Forbidden" },
            403,
          );
          await request(
            "POST",
            "",
            outsider,
            { device_id: firstDevice.id, name: "Forbidden" },
            403,
          );
          await request(
            "POST",
            "",
            owner,
            { device_id: firstDevice.id, name: "Invalid", channel: 2 },
            400,
          );
          firstRelay = (
            await request(
              "POST",
              "",
              owner,
              { device_id: firstDevice.id, name: "Fixture relay A" },
              201,
            )
          ).data.relay;
          secondRelay = (
            await request(
              "POST",
              "",
              owner,
              { device_id: secondDevice.id, name: "Fixture relay B" },
              201,
            )
          ).data.relay;
          await request(
            "POST",
            "",
            owner,
            { device_id: firstDevice.id, name: "Duplicate" },
            409,
          );
          await request("GET", `/${firstRelay.id}`, outsider, null, 403);
          assert.equal(
            (await request("GET", `?device_id=${firstDevice.id}`, operator))
              .data.relays[0].id,
            firstRelay.id,
          );
          await request("PATCH", `/${firstRelay.id}`, owner, {
            name: "Fixture relay updated",
          });
          await request(
            "PATCH",
            `/${firstRelay.id}`,
            owner,
            { reported_state: "on" },
            400,
          );
          await request("PUT", `/${firstRelay.id}`, owner, {
            is_enabled: false,
          });
          await request(
            "POST",
            `/${firstRelay.id}/commands`,
            owner,
            { command: "on" },
            409,
          );
          await request("PATCH", `/${firstRelay.id}`, owner, {
            is_enabled: true,
          });
        },
      );

      await t.test(
        "concurrent first commands on distinct farms avoid empty-history gap deadlocks and publish only to mock topics",
        async (subtest) => {
          const latest = model.latestCommand;
          let reached = 0;
          let release;
          const barrier = new Promise((resolve) => {
            release = resolve;
          });
          subtest.mock.method(model, "latestCommand", async (...args) => {
            const result = await latest(...args);
            reached++;
            if (reached === 2) release();
            await barrier;
            return result;
          });
          const responses = await Promise.all([
            request(
              "POST",
              `/${firstRelay.id}/commands`,
              owner,
              { command: "on" },
              202,
            ),
            request(
              "POST",
              `/${secondRelay.id}/commands`,
              owner,
              { command: "off" },
              202,
            ),
          ]);
          assert.equal(publications.length, 2);
          for (const response of responses) {
            assert.equal(response.data.command.status, "published");
            assert.equal(response.data.command.source, "manual");
            assert.equal(response.data.command.acked_at, null);
            assert.equal(response.data.broker_receipt_confirmed, false);
            assert.equal(response.data.device_acknowledged, false);
          }
          assert.deepEqual(
            publications.map((item) => item.topic).sort(),
            [
              `coasther/device/${firstDevice.topic_key}/control`,
              `coasther/device/${secondDevice.topic_key}/control`,
            ].sort(),
          );
          assert.equal(
            (await request("GET", `/${firstRelay.id}`, owner)).data.relay
              .reported_state,
            "unknown",
          );
        },
      );

      await t.test(
        "a pending device command rejects conflicting requests and injection without another audit or publish",
        async () => {
          await request(
            "POST",
            `/${firstRelay.id}/commands`,
            operator,
            { command: "off" },
            403,
          );
          await request(
            "POST",
            `/${firstRelay.id}/commands`,
            outsider,
            { command: "off" },
            403,
          );
          await request(
            "POST",
            `/${firstRelay.id}/commands`,
            owner,
            { command: "off", topic: "other/topic" },
            400,
          );
          const responses = await Promise.all([
            request(
              "POST",
              `/${firstRelay.id}/commands`,
              owner,
              { command: "off" },
              409,
            ),
            request(
              "POST",
              `/${firstRelay.id}/commands`,
              owner,
              { command: "on" },
              409,
            ),
          ]);
          assert.equal(
            responses.every((item) => item.success === false),
            true,
          );
          assert.equal(publications.length, 2);
          assert.equal(
            (await request("GET", `/${firstRelay.id}/commands`, operator)).data
              .commands.length,
            1,
          );
        },
      );

      await t.test(
        "synthetic retained/status/telemetry observations affect only fixture reported state and never acknowledge commands",
        async () => {
          const instant = new Date(Math.floor(Date.now() / 1000) * 1000);
          const payload = {
            room_id: 999999,
            relay_cutoff: false,
            relay_state: "on",
            source: "mqtt_connect",
            result: "relay_state_sync",
            recorded_at: instant,
          };
          assert.equal(
            (
              await service.observeControlStatus(
                firstDevice.topic_key,
                payload,
                { retained: true, receivedAt: instant },
              )
            ).outcome,
            "observed",
          );
          assert.equal(
            (
              await service.observeControlStatus(
                firstDevice.topic_key,
                { ...payload, relay_cutoff: true, relay_state: "off" },
                { retained: true, receivedAt: instant },
              )
            ).outcome,
            "stale_status",
          );
          const later = new Date(instant.getTime() + 1000);
          assert.equal(
            (
              await service.observeControlStatus(
                firstDevice.topic_key,
                {
                  ...payload,
                  source: "mqtt_command",
                  result: "status_sent",
                  relay_cutoff: true,
                  relay_state: "off",
                  recorded_at: later,
                },
                { receivedAt: later },
              )
            ).outcome,
            "observed",
          );
          const relay = (await request("GET", `/${firstRelay.id}`, owner)).data
            .relay;
          assert.equal(relay.coop_id, firstDevice.coop_id);
          assert.equal(relay.reported_state, "off");
          const command = (
            await request("GET", `/${firstRelay.id}/commands`, owner)
          ).data.commands[0];
          assert.equal(command.status, "published");
          assert.equal(command.acked_at, null);
          assert.equal(
            (
              await service.observeTelemetry(
                { device_id: firstDevice.id, coop_id: firstDevice.coop_id },
                {
                  relay_cutoff: false,
                  recorded_at: new Date(later.getTime() + 1000),
                },
                { source: "simulation" },
              )
            ).outcome,
            "simulation_ignored",
          );
        },
      );

      await t.test(
        "timeout audit uses conditional updates and never touches another device's command or claims cancellation",
        async (subtest) => {
          const command = (
            await request("GET", `/${firstRelay.id}/commands`, owner)
          ).data.commands[0];
          await db.query(
            "UPDATE relay_commands SET requested_at = ? WHERE id = ?",
            [new Date(Date.now() - 301000), command.id],
          );
          subtest.mock.method(model, "pendingBefore", async () => [
            {
              id: command.id,
              relay_id: firstRelay.id,
              device_id: firstDevice.id,
              coop_id: firstDevice.coop_id,
            },
          ]);
          assert.equal(await service.checkTimeouts(), 1);
          const timedOut = (
            await request("GET", `/${firstRelay.id}/commands`, owner)
          ).data.commands[0];
          assert.equal(timedOut.status, "timed_out");
          assert.equal(timedOut.acked_at, null);
          assert.equal(
            (await request("GET", `/${secondRelay.id}/commands`, owner)).data
              .commands[0].status,
            "published",
          );
        },
      );

      await t.test(
        "broker unavailable creates an auditable failure without network queuing or token exposure",
        async () => {
          client.connected = false;
          const response = await request(
            "POST",
            `/${firstRelay.id}/commands`,
            owner,
            { command: "off" },
            503,
          );
          assert.equal(response.errors.command.status, "failed");
          assert.equal(
            response.errors.command.failure_reason,
            "broker_not_connected",
          );
          assert.equal(response.errors.command.acked_at, null);
          assert.equal(publications.length, 2);
          await request("DELETE", `/${firstRelay.id}`, owner);
          assert.equal(
            (await request("GET", `/${firstRelay.id}`, operator)).data.relay
              .is_enabled,
            0,
          );
        },
      );
    } finally {
      service.configure();
      try {
        await cleanup();
      } finally {
        if (server) await new Promise((resolve) => server.close(resolve));
        await db.end();
        oldCommandToken === undefined
          ? delete process.env.MQTT_CMD_TOKEN
          : (process.env.MQTT_CMD_TOKEN = oldCommandToken);
      }
    }
  },
);
