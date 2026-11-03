const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const crypto = require("node:crypto");
const { Server } = require("socket.io");
const { io: clientIo } = require("socket.io-client");
const jwt = require("jsonwebtoken");
const userModel = require("../src/models/user.model");
const access = require("../src/services/access.service");
const service = require("../src/services/broilerSocket.service");

test(
  "broiler sockets authenticate and isolate real local transports by coop",
  { timeout: 15000 },
  async (t) => {
    process.env.JWT_SECRET = crypto.randomBytes(32).toString("hex");
    const users = new Map([
      [1, { id: 1, role: "operator" }],
      [2, { id: 2, role: "operator" }],
      [3, { id: 3, role: "admin" }],
    ]);
    const allowed = new Map([
      [1, new Set([10])],
      [2, new Set([20])],
      [3, new Set()],
    ]);
    t.mock.method(
      userModel,
      "findById",
      async (id) => users.get(Number(id)) || null,
    );
    t.mock.method(access, "requireCoop", async (user, coopId) => {
      if (user.role !== "admin" && !allowed.get(user.id)?.has(coopId)) {
        throw Object.assign(new Error("Farm access denied"), {
          statusCode: 403,
        });
      }
      return { id: coopId };
    });
    const server = http.createServer();
    const io = new Server(server, { serveClient: false });
    service.attach(io);
    service.attach(io);
    assert.equal(io.listenerCount("connection"), 1);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const clients = new Set();
    const token = (id, claimedRole = "operator") =>
      jwt.sign({ id, role: claimedRole }, process.env.JWT_SECRET, {
        expiresIn: "1h",
      });
    const connect = async (auth, extraHeaders) => {
      const client = clientIo(base, {
        auth,
        extraHeaders,
        autoConnect: false,
        forceNew: true,
        reconnection: false,
        transports: ["websocket"],
      });
      clients.add(client);
      const result = new Promise((resolve) => {
        client.once("connect", () => resolve({ client }));
        client.once("connect_error", (error) => resolve({ client, error }));
      });
      client.connect();
      return result;
    };
    const acknowledge = (client, event, payload) =>
      client.timeout(1500).emitWithAck(event, payload);
    const received = (client, event) =>
      new Promise((resolve) => client.once(event, resolve));
    const barrier = (client) =>
      acknowledge(client, "coop:unsubscribe", { coop_id: 999 });
    let first, second, admin;

    try {
      await t.test(
        "missing, invalid, expired and deleted-account JWTs are rejected",
        async () => {
          for (const auth of [
            undefined,
            { token: "invalid" },
            { token: token(999) },
            {
              token: jwt.sign({ id: 1 }, process.env.JWT_SECRET, {
                expiresIn: -1,
              }),
            },
          ]) {
            const result = await connect(auth);
            assert.equal(result.error?.message, "Unauthorized");
            assert.equal(result.error?.data.statusCode, 401);
            result.client.disconnect();
          }
        },
      );

      await t.test(
        "current account role and coop membership authorize each subscription",
        async () => {
          first = (await connect({ token: token(1, "admin") })).client;
          second = (
            await connect(undefined, { Authorization: `Bearer ${token(2)}` })
          ).client;
          admin = (await connect({ token: token(3) })).client;
          assert.equal(first.connected, true);
          assert.equal(
            (await acknowledge(first, "coop:subscribe", { coop_id: 20 }))
              .statusCode,
            403,
          );
          assert.equal(
            (await acknowledge(first, "coop:subscribe", { coop_id: "10" }))
              .statusCode,
            400,
          );
          assert.equal(
            (
              await acknowledge(first, "coop:subscribe", {
                coop_id: 10,
                role: "admin",
              })
            ).statusCode,
            400,
          );
          assert.equal(
            (await acknowledge(first, "coop:subscribe", { coop_id: 10 }))
              .success,
            true,
          );
          assert.equal(
            (await acknowledge(second, "coop:subscribe", { coop_id: 20 }))
              .success,
            true,
          );
          assert.equal(
            (await acknowledge(admin, "coop:subscribe", { coop_id: 10 }))
              .success,
            true,
          );
        },
      );

      await t.test(
        "meter updates reach authorized subscribers without cross-coop delivery or private fields",
        async () => {
          let secondReceived = 0;
          second.on("meter_update", () => secondReceived++);
          const firstEvent = received(first, "meter_update");
          const adminEvent = received(admin, "meter_update");
          const result = await service.publish(io, "meter_update", {
            coop_id: 10,
            device_id: 2,
            meter_id: 3,
            meter_uid: "legacy-water",
            type: "water",
            unit: "liter",
            reading_value: 4,
            delta_value: 1,
            reading_status: "accepted",
            counter_epoch: 0,
            recorded_at: "2026-11-04T01:00:00.000Z",
            received_at: "2026-11-04T01:00:01.000Z",
            flock_cycle_id: 4,
            source: "simulation",
            is_latest: true,
            room_id: 999,
            wifi_ssid: "private",
            token: "private",
          });
          assert.equal(result.delivered, 2);
          const envelope = await firstEvent;
          assert.deepEqual(await adminEvent, envelope);
          assert.equal(envelope.source, "simulation");
          assert.equal(envelope.is_latest, true);
          for (const key of ["room_id", "wifi_ssid", "token"])
            assert.equal(key in envelope, false);
          await barrier(second);
          assert.equal(secondReceived, 0);
        },
      );

      await t.test(
        "telemetry sanitizes snapshots and preserves the distinction between newest and buffered data",
        async () => {
          const recordedAt = new Date().toISOString();
          const event = received(first, "telemetry_update");
          await service.publish(io, "telemetry_update", {
            coop_id: 10,
            device_id: 2,
            recorded_at: recordedAt,
            source: "sensor",
            is_latest: true,
            snapshot: {
              source: "sensor",
              recorded_at: recordedAt,
              power_w: 66,
              flow_rate_lpm: 0,
              water_total_liter: 4,
              voltage_v: 220,
              wifi_ssid: "private",
              room_id: 1,
              phase_data_json: '{"secret":"private"}',
            },
          });
          const envelope = await event;
          assert.equal(envelope.snapshot.power_w, 66);
          assert.equal(envelope.snapshot.flow_rate_lpm, 0);
          assert.equal(envelope.snapshot.water_total_liter, 4);
          assert.equal(envelope.snapshot.voltage_v, 220);
          for (const key of [
            "wifi_ssid",
            "room_id",
            "phase_data_json",
            "secret",
          ])
            assert.equal(key in envelope.snapshot, false);
          const historicalEvent = received(first, "meter_update");
          await service.publish(io, "meter_update", {
            coop_id: 10,
            meter_id: 3,
            reading_status: "out_of_order",
            is_latest: false,
            source: "simulation",
          });
          assert.equal((await historicalEvent).is_latest, false);
          await assert.rejects(
            service.publish(io, "iot_log", { coop_id: 10 }),
            /Unsupported/,
          );
        },
      );

      await t.test(
        "fresh partial telemetry masks retained stale fields and exposes only safe field timestamps",
        async () => {
          const recordedAt = new Date().toISOString();
          const oldPowerAt = new Date(Date.now() - 3600000).toISOString();
          const event = received(first, "telemetry_update");
          await service.publish(io, "telemetry_update", {
            coop_id: 10,
            device_id: 2,
            recorded_at: recordedAt,
            source: "sensor",
            is_latest: true,
            snapshot: {
              coop_id: 10,
              device_id: 2,
              source: "sensor",
              recorded_at: recordedAt,
              power_w: 66,
              flow_rate_lpm: 1.5,
              wifi_ssid: "private",
              phase_data_json: JSON.stringify({
                metric_recorded_at: {
                  power_w: oldPowerAt,
                  flow_rate_lpm: recordedAt,
                  wifi_ssid: "private",
                },
                metric_device_id: {
                  power_w: 2,
                  flow_rate_lpm: 2,
                  wifi_ssid: "private",
                },
                command_token: "private",
              }),
            },
          });
          const envelope = await event;
          assert.equal(envelope.snapshot.power_w, null);
          assert.equal(envelope.snapshot.field_status.power_w, "stale");
          assert.equal(
            envelope.snapshot.metric_recorded_at.power_w,
            oldPowerAt,
          );
          assert.equal(envelope.snapshot.metric_device_id.power_w, 2);
          assert.equal(envelope.snapshot.flow_rate_lpm, 1.5);
          assert.equal(envelope.snapshot.field_status.flow_rate_lpm, "live");
          assert.equal(envelope.snapshot.status, "live");
          assert.equal(JSON.stringify(envelope).includes("private"), false);
          assert.equal("phase_data_json" in envelope.snapshot, false);
        },
      );

      await t.test(
        "an older packet finishing later cannot become the newest live value",
        async () => {
          const newer = received(first, "meter_update");
          await service.publish(io, "meter_update", {
            coop_id: 10,
            meter_id: 3,
            recorded_at: "2026-11-04T01:01:00.000Z",
            source: "simulation",
            is_latest: true,
          });
          assert.equal((await newer).is_latest, true);
          const older = received(first, "meter_update");
          await service.publish(io, "meter_update", {
            coop_id: 10,
            meter_id: 3,
            recorded_at: "2026-11-04T01:00:30.000Z",
            source: "simulation",
            is_latest: true,
          });
          assert.equal((await older).is_latest, false);
        },
      );

      await t.test(
        "delayed MQTT online status cannot supersede a newer real timeout, while simulation stays separate",
        async () => {
          const status = async (connectivity_status, source, observed_at) => {
            const event = received(first, "device_status");
            await service.publish(io, "device_status", {
              coop_id: 10,
              device_id: 2,
              connectivity_status,
              source,
              observed_at,
              is_latest: true,
            });
            return event;
          };
          assert.equal(
            (await status("offline", "timeout", "2026-11-04T01:04:00.000Z"))
              .is_latest,
            true,
          );
          assert.equal(
            (await status("online", "mqtt", "2026-11-04T01:03:00.000Z"))
              .is_latest,
            false,
          );
          assert.equal(
            (await status("online", "simulation", "2026-11-04T20:00:00.000Z"))
              .is_latest,
            true,
          );
          assert.equal(
            (await status("online", "mqtt", "2026-11-04T01:05:00.000Z"))
              .is_latest,
            true,
          );
        },
      );

      await t.test(
        "membership revocation removes an existing subscriber before the next update",
        async () => {
          allowed.get(1).delete(10);
          const revoke = received(first, "coop:revoked");
          let updates = 0;
          first.on("device_status", () => updates++);
          const result = await service.publish(io, "device_status", {
            coop_id: 10,
            device_id: 2,
            connectivity_status: "online",
            source: "simulation",
          });
          assert.equal(result.delivered, 1);
          assert.deepEqual(await revoke, { coop_id: 10 });
          await barrier(first);
          assert.equal(updates, 0);
          assert.equal(
            io.sockets.sockets.get(first.id).rooms.has("coop:10"),
            false,
          );
          allowed.get(1).add(10);
          await acknowledge(first, "coop:subscribe", { coop_id: 10 });
        },
      );

      await t.test(
        "database role demotion overrides an admin claim and deleted accounts disconnect",
        async () => {
          users.set(3, { id: 3, role: "operator" });
          const revoke = received(admin, "coop:revoked");
          const result = await service.publish(io, "device_status", {
            coop_id: 10,
            device_id: 2,
            connectivity_status: "offline",
          });
          assert.equal(result.delivered, 1);
          await revoke;
          users.delete(1);
          const disconnect = received(first, "disconnect");
          assert.equal(
            (
              await service.publish(io, "device_status", {
                coop_id: 10,
                device_id: 2,
                connectivity_status: "offline",
              })
            ).delivered,
            0,
          );
          await disconnect;
          assert.equal(first.connected, false);
          users.set(1, { id: 1, role: "operator" });
        },
      );

      await t.test(
        "unsubscribe and reconnect do not keep stale rooms or duplicate event listeners",
        async () => {
          first = (await connect({ token: token(1) })).client;
          await acknowledge(first, "coop:subscribe", { coop_id: 10 });
          await acknowledge(first, "coop:subscribe", { coop_id: 10 });
          assert.equal(
            io.sockets.sockets.get(first.id).listenerCount("coop:subscribe"),
            1,
          );
          assert.equal(
            (await acknowledge(first, "coop:unsubscribe", { coop_id: 10 }))
              .success,
            true,
          );
          assert.equal(
            (
              await service.publish(io, "meter_update", {
                coop_id: 10,
                meter_id: 3,
                is_latest: true,
              })
            ).delivered,
            0,
          );
          const oldId = first.id;
          first.disconnect();
          first.connect();
          await received(first, "connect");
          assert.notEqual(first.id, oldId);
          assert.equal(
            io.sockets.sockets.get(first.id).rooms.has("coop:10"),
            false,
          );
          await acknowledge(first, "coop:subscribe", { coop_id: 10 });
          const event = received(first, "meter_update");
          const result = await service.publish(io, "meter_update", {
            coop_id: 10,
            meter_id: 3,
            is_latest: true,
          });
          assert.equal(result.delivered, 1);
          await event;
        },
      );
    } finally {
      for (const client of clients) client.disconnect();
      await new Promise((resolve) => io.close(resolve));
    }
  },
);
