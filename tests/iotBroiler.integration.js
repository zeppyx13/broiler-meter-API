require("dotenv").config({ quiet: true });
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const bcrypt = require("bcryptjs");
const { Server } = require("socket.io");
const { io: clientIo } = require("socket.io-client");

if (
  process.env.NODE_ENV === "production" ||
  process.env.DB_NAME !== "coasther_broiler"
) {
  throw new Error(
    "Phase 2 integration tests require the imported development coasther_broiler database",
  );
}
process.env.NODE_ENV = "test";
process.env.JWT_SECRET ||= crypto.randomBytes(32).toString("hex");
const db = require("../src/config/db");
const app = require("../src/app");
const logger = require("../src/config/logger");
for (const transport of logger.transports) transport.silent = true;
const users = require("../src/models/user.model");
const { verify } = require("../src/services/schemaCompatibility.service");
const daily = require("../src/services/dailyMetrics.service");
const sockets = require("../src/services/broilerSocket.service");
const { localDate } = require("../src/utils/farmDate");
let ingestion = require("../src/services/iotBroiler.service");

test(
  "Phase 2 HTTP, simulated MQTT ingress and persisted metrics on imported development schema",
  { timeout: 90000 },
  async (t) => {
    const marker = `iot-test-${crypto.randomUUID()}`;
    const emails = [];
    const clients = new Set();
    const password = crypto.randomBytes(24).toString("base64url");
    const timezone = "Asia/Makassar";
    const today = localDate(timezone);
    const dayStart = daily.calendarBoundary(today, timezone).getTime();
    const baseTime = Math.max(
      dayStart + 1000,
      Math.floor(Date.now() / 1000) * 1000 - 90000,
    );
    const instant = (seconds = 0, milliseconds = 0) =>
      new Date(baseTime + seconds * 1000 + milliseconds);
    const wita = (date) =>
      `${new Date(date.getTime() + 8 * 3600000).toISOString().slice(0, -1)}+08:00`;
    let server, io, base, manager, operator, viewer, outsider, admin;
    let farm,
      coop,
      cycle,
      device,
      water,
      energy,
      authorizedSocket,
      outsiderSocket;
    let summaryExample;

    async function request(method, path, token, payload, expected = 200) {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(payload !== undefined
            ? { "Content-Type": "application/json" }
            : {}),
        },
        ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
      });
      const body = await response.json();
      assert.equal(
        response.status,
        expected,
        `${method} ${path}: ${JSON.stringify(body)}`,
      );
      return body.data;
    }

    async function account(label, role) {
      const email = `${marker}-${label}@example.invalid`;
      emails.push(email);
      const id = await users.createUser({
        name: `${marker}-${label}`,
        email,
        role,
        password_hash: await bcrypt.hash(password, 4),
      });
      const result = await request("POST", "/api/auth/login", null, {
        email,
        password,
      });
      assert.equal(result.user.id, id);
      return result;
    }

    async function simulate(topic, payload, extra = {}) {
      const at =
        payload && typeof payload === "object"
          ? Date.parse(payload.recorded_at)
          : NaN;
      const receivedAt = new Date(
        Math.max(Date.now(), Number.isFinite(at) ? at + 1000 : 0),
      );
      return ingestion.handleMessage(
        topic,
        Buffer.isBuffer(payload)
          ? payload
          : Buffer.from(JSON.stringify(payload)),
        {
          ...extra,
          source: "simulation",
          receivedAt,
        },
      );
    }

    const reading = (meter, value, seconds, milliseconds = 0) =>
      simulate(`coasther/meter/${meter.meter_uid}/reading`, {
        reading_value: value,
        recorded_at: wita(instant(seconds, milliseconds)),
      });
    const rawCount = async () => {
      const [[row]] = await db.query(
        "SELECT COUNT(*) AS count FROM meter_readings WHERE coop_id = ?",
        [coop.id],
      );
      return Number(row.count);
    };

    async function connect(token) {
      const client = clientIo(base, {
        auth: { token },
        forceNew: true,
        reconnection: false,
        autoConnect: false,
        transports: ["websocket"],
        timeout: 2000,
      });
      clients.add(client);
      await new Promise((resolve, reject) => {
        client.once("connect", resolve);
        client.once("connect_error", reject);
        client.connect();
      });
      return client;
    }

    async function cleanup() {
      const connection = await db.getConnection();
      try {
        await connection.beginTransaction();
        const [fixtureUsers] = emails.length
          ? await connection.query(
              "SELECT id FROM users WHERE email IN (?) AND name LIKE ?",
              [emails, `${marker}%`],
            )
          : [[]];
        const ids = fixtureUsers.map((row) => row.id);
        if (ids.length) {
          const [fixtureFarms] = await connection.query(
            "SELECT id FROM farms WHERE owner_user_id IN (?) AND name LIKE ?",
            [ids, `${marker}%`],
          );
          const farmIds = fixtureFarms.map((row) => row.id);
          await connection.query(
            "UPDATE users SET default_coop_id = NULL WHERE id IN (?)",
            [ids],
          );
          if (farmIds.length) {
            // Every deletion is scoped to farms owned and named by this unique run.
            await connection.query(
              "DELETE dm FROM daily_coop_metrics dm JOIN coops c ON c.id = dm.coop_id WHERE c.farm_id IN (?)",
              [farmIds],
            );
            await connection.query(
              "DELETE live FROM coop_live_status live JOIN coops c ON c.id = live.coop_id WHERE c.farm_id IN (?)",
              [farmIds],
            );
            await connection.query(
              "DELETE r FROM meter_readings r JOIN coops c ON c.id = r.coop_id WHERE c.farm_id IN (?)",
              [farmIds],
            );
            await connection.query(
              "DELETE m FROM meters m JOIN devices d ON d.id = m.device_id JOIN coops c ON c.id = d.coop_id WHERE c.farm_id IN (?)",
              [farmIds],
            );
            await connection.query(
              "DELETE d FROM devices d JOIN coops c ON c.id = d.coop_id WHERE c.farm_id IN (?)",
              [farmIds],
            );
            await connection.query(
              "DELETE e FROM flock_events e JOIN flock_cycles fc ON fc.id = e.flock_cycle_id JOIN coops c ON c.id = fc.coop_id WHERE c.farm_id IN (?)",
              [farmIds],
            );
            await connection.query(
              "DELETE fc FROM flock_cycles fc JOIN coops c ON c.id = fc.coop_id WHERE c.farm_id IN (?)",
              [farmIds],
            );
            await connection.query("DELETE FROM coops WHERE farm_id IN (?)", [
              farmIds,
            ]);
            await connection.query(
              "DELETE FROM farm_members WHERE farm_id IN (?)",
              [farmIds],
            );
            await connection.query("DELETE FROM farms WHERE id IN (?)", [
              farmIds,
            ]);
          }
          await connection.query("DELETE FROM users WHERE id IN (?)", [ids]);
        }
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
      const [[session]] = await db.query(
        "SELECT @@session.time_zone AS timezone",
      );
      assert.equal(session.timezone, "+00:00");
      server = app.listen(0, "127.0.0.1");
      await new Promise((resolve) => server.once("listening", resolve));
      base = `http://127.0.0.1:${server.address().port}`;
      io = new Server(server, { serveClient: false });
      sockets.attach(io);
      admin = await account("admin", "admin");
      manager = await account("manager", "manager");
      operator = await account("operator", "operator");
      viewer = await account("viewer", "operator");
      outsider = await account("outsider", "operator");
      farm = (
        await request(
          "POST",
          "/api/farms",
          manager.token,
          {
            name: marker,
            timezone,
            electricity_rate_idr_per_kwh: 1000,
            water_rate_idr_per_m3: 2000,
          },
          201,
        )
      ).farm;
      for (const [person, role] of [
        [operator, "operator"],
        [viewer, "viewer"],
      ]) {
        await request(
          "POST",
          `/api/farms/${farm.id}/members`,
          manager.token,
          { user_id: person.user.id, role },
          201,
        );
      }
      coop = (
        await request(
          "POST",
          "/api/coops",
          manager.token,
          {
            farm_id: farm.id,
            code: "IOT",
            name: "Synthetic integration coop",
            capacity_birds: 100,
          },
          201,
        )
      ).coop;
      cycle = await request(
        "POST",
        "/api/flock-cycles",
        manager.token,
        {
          coop_id: coop.id,
          cycle_code: "SIMULATION",
          placement_date: today,
          initial_population: 100,
        },
        201,
      );

      await t.test(
        "pairing APIs enforce authentication, scope and management roles",
        async () => {
          await request("GET", "/api/devices", null, undefined, 401);
          await request("GET", "/api/meters", null, undefined, 401);
          const payload = {
            coop_id: coop.id,
            device_uid: `${marker}.esp32:1`,
            mqtt_topic_key: `${marker}.room:1`,
            name: "Synthetic panel",
          };
          await request("POST", "/api/devices", operator.token, payload, 403);
          await request("POST", "/api/devices", viewer.token, payload, 403);
          await request("POST", "/api/devices", outsider.token, payload, 403);
          device = (
            await request("POST", "/api/devices", manager.token, payload, 201)
          ).device;
          assert.equal(device.connectivity_status, "unknown");
          await request("POST", "/api/devices", manager.token, payload, 409);
          await request(
            "POST",
            "/api/devices",
            manager.token,
            { ...payload, device_uid: `${marker}-other` },
            409,
          );
          await request(
            "POST",
            "/api/devices",
            manager.token,
            { ...payload, mqtt_topic_key: "invalid/+" },
            400,
          );
          await request(
            "GET",
            `/api/devices/${device.id}`,
            outsider.token,
            undefined,
            403,
          );
          await request(
            "GET",
            `/api/devices?coop_id=${coop.id}`,
            outsider.token,
            undefined,
            403,
          );
          assert.equal(
            (await request("GET", "/api/devices", outsider.token)).devices.some(
              (row) => row.id === device.id,
            ),
            false,
          );
          assert.equal(
            (await request("GET", `/api/devices/${device.id}`, admin.token))
              .device.id,
            device.id,
          );
          assert.equal(
            (await request("GET", `/api/devices/${device.id}`, viewer.token))
              .device.id,
            device.id,
          );
          await request("PATCH", `/api/devices/${device.id}`, manager.token, {
            firmware_version: "3.1",
            name: "Updated synthetic panel",
          });
          await request(
            "PATCH",
            `/api/devices/${device.id}`,
            manager.token,
            { mqtt_topic_key: "remapped" },
            400,
          );
        },
      );

      await t.test(
        "meter CRUD validates units, UID conflicts, channels and immutable mappings",
        async () => {
          const payload = {
            device_id: device.id,
            meter_uid: `${marker}.water:1`,
            type: "water",
            unit: "liter",
            channel: "main",
          };
          await request("POST", "/api/meters", outsider.token, payload, 403);
          await request("POST", "/api/meters", operator.token, payload, 403);
          await request(
            "POST",
            "/api/meters",
            manager.token,
            { ...payload, unit: "kwh" },
            400,
          );
          water = (
            await request("POST", "/api/meters", manager.token, payload, 201)
          ).meter;
          await request("POST", "/api/meters", manager.token, payload, 409);
          await request(
            "POST",
            "/api/meters",
            manager.token,
            { ...payload, meter_uid: `${marker}-duplicate-channel` },
            409,
          );
          energy = (
            await request(
              "POST",
              "/api/meters",
              manager.token,
              {
                device_id: device.id,
                meter_uid: `${marker}.energy:1`,
                type: "electricity",
                unit: "kwh",
                channel: "main",
              },
              201,
            )
          ).meter;
          await request(
            "POST",
            "/api/meters",
            manager.token,
            {
              device_id: device.id,
              meter_uid: `${marker}-overlap`,
              type: "electricity",
              unit: "kwh",
              channel: "phase_a",
            },
            409,
          );
          await request(
            "GET",
            `/api/meters/${water.id}`,
            outsider.token,
            undefined,
            403,
          );
          await request(
            "GET",
            `/api/meters?device_id=${device.id}`,
            outsider.token,
            undefined,
            403,
          );
          assert.equal(
            (await request("GET", "/api/meters", outsider.token)).meters.some(
              (row) => row.id === water.id,
            ),
            false,
          );
          assert.equal(
            (
              await request(
                "GET",
                `/api/meters?coop_id=${coop.id}`,
                viewer.token,
              )
            ).meters.length,
            2,
          );
          await request("PATCH", `/api/meters/${water.id}`, manager.token, {
            installed_at: wita(instant()),
          });
          await request(
            "PATCH",
            `/api/meters/${water.id}`,
            manager.token,
            { channel: "replacement" },
            400,
          );
          await request(
            "PATCH",
            `/api/meters/${water.id}`,
            manager.token,
            { last_reading_value: 999 },
            400,
          );
        },
      );

      await t.test(
        "invalid, unmapped and diagnostic messages do not persist readings",
        async () => {
          const payload = { reading_value: 1, recorded_at: wita(instant()) };
          assert.equal(
            (await simulate("other/topic", payload)).outcome,
            "unknown_topic",
          );
          assert.equal(
            (
              await simulate(
                `coasther/meter/${marker}-missing/reading`,
                payload,
              )
            ).outcome,
            "unmapped",
          );
          assert.equal(
            (
              await simulate(
                `coasther/meter/${water.meter_uid}/reading`,
                Buffer.from("{"),
              )
            ).outcome,
            "invalid_payload",
          );
          assert.equal(
            (
              await simulate(
                `coasther/meter/${water.meter_uid}/reading`,
                Buffer.alloc(17000),
              )
            ).outcome,
            "invalid_payload",
          );
          assert.equal(
            (
              await simulate(`coasther/meter/${water.meter_uid}/reading`, {
                ...payload,
                reading_value: -1,
              })
            ).outcome,
            "invalid_payload",
          );
          assert.equal(
            (
              await simulate(`coasther/device/${device.mqtt_topic_key}/log`, {
                wifi_ssid: "synthetic-private-field",
              })
            ).outcome,
            "diagnostic_ignored",
          );
          assert.equal(await rawCount(), 0);
        },
      );

      await t.test(
        "baseline, fractional-second dedupe and six-decimal normalization persist once",
        async () => {
          const first = await reading(water, 100.1234567, 0, 123);
          assert.equal(first.outcome, "stored");
          assert.equal(first.reading_status, "baseline");
          assert.equal(Number(first.delta_value), 0);
          assert.equal(first.flock_cycle_id, cycle.id);
          assert.equal(first.recorded_at.getTime(), instant().getTime());
          assert.equal(
            (await reading(water, 100.1234567, 0, 123)).outcome,
            "duplicate",
          );
          assert.equal(
            (await reading(water, 100.12345671, 0, 899)).outcome,
            "duplicate",
          );
          assert.equal(await rawCount(), 1);
          const [[stored]] = await db.query(
            "SELECT reading_value, source, recorded_at FROM meter_readings WHERE id = ?",
            [first.id],
          );
          assert.equal(stored.reading_value, "100.123457");
          assert.equal(stored.source, "simulation");
          assert.equal(stored.recorded_at.getTime(), instant().getTime());
        },
      );

      await t.test(
        "normal increments, conflicts and buffered data cannot inflate consumption",
        async () => {
          const normal = await reading(water, 110.123457, 10);
          assert.equal(normal.reading_status, "accepted");
          assert.equal(Number(normal.delta_value), 10);
          const conflict = await reading(water, 111.123457, 10, 456);
          assert.equal(conflict.reading_status, "suspect");
          assert.equal(Number(conflict.delta_value), 0);
          assert.equal(conflict.is_latest, false);
          const buffered = await reading(water, 105, 5);
          assert.equal(buffered.reading_status, "out_of_order");
          assert.equal(Number(buffered.delta_value), 0);
          const bufferedConflict = await reading(water, 106, 5, 123);
          assert.equal(bufferedConflict.reading_status, "suspect");
          assert.equal(Number(bufferedConflict.delta_value), 0);
        },
      );

      await t.test(
        "reset creates a baseline epoch and simultaneous duplicate delivery writes once",
        async () => {
          const reset = await reading(water, 2, 20);
          assert.equal(reset.reading_status, "reset");
          assert.equal(reset.counter_epoch, 1);
          assert.equal(Number(reset.delta_value), 0);
          assert.equal(Number((await reading(water, 5, 30)).delta_value), 3);
          const before = await rawCount();
          const results = await Promise.all([
            reading(water, 6, 40),
            reading(water, 6, 40),
          ]);
          assert.deepEqual(results.map((row) => row.outcome).sort(), [
            "duplicate",
            "stored",
          ]);
          assert.equal(await rawCount(), before + 1);
        },
      );

      await t.test(
        "module restart resumes the persisted simulation cursor and rejects uncertain drops",
        async () => {
          delete require.cache[
            require.resolve("../src/services/iotBroiler.service")
          ];
          ingestion = require("../src/services/iotBroiler.service");
          const resumed = await reading(water, 8, 50);
          assert.equal(resumed.reading_status, "accepted");
          assert.equal(resumed.counter_epoch, 1);
          assert.equal(Number(resumed.delta_value), 2);
          assert.equal(
            (await reading(water, 7.5, 60)).reading_status,
            "suspect",
          );
          assert.equal(Number((await reading(water, 9, 70)).delta_value), 1);
          await reading(energy, 20, 0);
          assert.equal(
            Number((await reading(energy, 20.5, 10)).delta_value),
            0.5,
          );
          assert.equal(
            Number((await reading(energy, 20.75, 20)).delta_value),
            0.25,
          );
          await request(
            "POST",
            `/api/flock-cycles/${cycle.id}/events`,
            operator.token,
            {
              event_type: "mortality",
              population_change: -10,
              event_date: today,
            },
            201,
          );
        },
      );

      await t.test(
        "actual Socket.io transport authenticates DB users and isolates simulated coop events",
        async () => {
          authorizedSocket = await connect(manager.token);
          outsiderSocket = await connect(outsider.token);
          const subscribed = await authorizedSocket
            .timeout(2000)
            .emitWithAck("coop:subscribe", { coop_id: coop.id });
          assert.equal(subscribed.success, true);
          const denied = await outsiderSocket
            .timeout(2000)
            .emitWithAck("coop:subscribe", { coop_id: coop.id });
          assert.equal(denied.statusCode, 403);
          const unauthorizedEvents = [];
          outsiderSocket.on("telemetry_update", (event) =>
            unauthorizedEvents.push(event),
          );
          const eventPromise = new Promise((resolve, reject) => {
            const timer = setTimeout(
              () => reject(new Error("Missing authorized telemetry event")),
              2500,
            );
            authorizedSocket.once("telemetry_update", (event) => {
              clearTimeout(timer);
              resolve(event);
            });
          });
          const timestamp = new Date(
            Math.floor(Date.now() / 1000) * 1000 - 3000,
          );
          const result = await simulate(
            `coasther/telemetry/${device.mqtt_topic_key}/live`,
            {
              room_id: 999999999,
              recorded_at: wita(timestamp),
              flow_rate_lpm: 2,
              water_total_liter: 9,
              voltage: 220,
              current: 0.5,
              power: 110,
              energy_kwh_total: 20.75,
              frequency: 50,
              pf: 0.99,
              ntp_synced: true,
              wifi_ssid: "synthetic-private-field",
              command_token: "synthetic-private-field",
            },
            { io },
          );
          assert.equal(result.outcome, "stored");
          const event = await eventPromise;
          assert.equal(event.coop_id, coop.id);
          assert.equal(event.source, "simulation");
          assert.equal(event.snapshot.power_w, 110);
          assert.equal(
            JSON.stringify(event).includes("synthetic-private-field"),
            false,
          );
          await outsiderSocket
            .timeout(2000)
            .emitWithAck("coop:unsubscribe", { coop_id: 999999999 });
          assert.equal(unauthorizedEvents.length, 0);
        },
      );

      await t.test(
        "snapshot ordering, legacy room mapping and partial updates retain safe provenance",
        async () => {
          const [[previous]] = await db.query(
            "SELECT * FROM coop_live_status WHERE coop_id = ?",
            [coop.id],
          );
          const oldTimestamp = new Date(previous.recorded_at.getTime() - 60000);
          const older = await simulate(
            `coasther/telemetry/${device.mqtt_topic_key}/live`,
            {
              recorded_at: wita(oldTimestamp),
              power: 999,
            },
          );
          assert.equal(older.outcome, "historical_telemetry");
          const later = new Date(previous.recorded_at.getTime() + 1000);
          const partial = await simulate(
            `coasther/telemetry/${device.mqtt_topic_key}/live`,
            {
              room_id: 999999999,
              recorded_at: wita(later),
              flow_rate_lpm: 3,
            },
          );
          assert.equal(partial.outcome, "stored");
          assert.equal(partial.snapshot.power_w, 110);
          assert.equal(partial.snapshot.flow_rate_lpm, 3);
          const duplicate = await simulate(
            `coasther/telemetry/${device.mqtt_topic_key}/live`,
            { recorded_at: wita(later), flow_rate_lpm: 77 },
          );
          assert.equal(duplicate.outcome, "historical_telemetry");
          const [[stored]] = await db.query(
            "SELECT * FROM coop_live_status WHERE coop_id = ?",
            [coop.id],
          );
          assert.equal(Number(stored.flow_rate_lpm), 3);
          assert.equal(Number(stored.power_w), 110);
          assert.equal(stored.source, "simulation");
          assert.equal(stored.recorded_at.getTime(), later.getTime());
          assert.equal(
            JSON.stringify(stored).includes("synthetic-private-field"),
            false,
          );
        },
      );

      await t.test(
        "simulation never changes physical heartbeat or meter cursor state",
        async () => {
          const [[physical]] = await db.query(
            "SELECT last_seen_at, connectivity_status FROM devices WHERE id = ?",
            [device.id],
          );
          assert.equal(physical.last_seen_at, null);
          assert.equal(physical.connectivity_status, "unknown");
          const [physicalMeters] = await db.query(
            "SELECT last_reading_value, last_reading_at, counter_epoch FROM meters WHERE device_id = ?",
            [device.id],
          );
          for (const row of physicalMeters) {
            assert.equal(row.last_reading_value, null);
            assert.equal(row.last_reading_at, null);
            assert.equal(row.counter_epoch, 0);
          }
          const [[sources]] = await db.query(
            "SELECT COUNT(*) AS count FROM meter_readings WHERE coop_id = ? AND source <> 'simulation'",
            [coop.id],
          );
          assert.equal(Number(sources.count), 0);
        },
      );

      await t.test(
        "daily metrics are idempotent, farm-local, simulated and population-normalized",
        async () => {
          const first = await daily.recalculateCycle({
            flock_cycle_id: cycle.id,
          });
          const second = await daily.recalculateCycle({
            flock_cycle_id: cycle.id,
          });
          assert.deepEqual(first, second);
          assert.equal(first.simulation.length, 1);
          const point = first.simulation[0];
          assert.equal(point.metric_date, today);
          assert.equal(point.day_age, 1);
          assert.equal(point.water_liters, 17);
          assert.equal(point.energy_kwh, 0.75);
          assert.equal(point.population_basis, 90);
          assert.equal(point.water_liters_per_bird, 0.188889);
          assert.equal(point.energy_wh_per_bird, 8.3333);
          assert.equal(point.electricity_cost_idr, 750);
          assert.equal(point.water_cost_idr, 34);
          assert.equal(first.real[0].water_liters, null);
          const [persisted] = await db.query(
            "SELECT * FROM daily_coop_metrics WHERE flock_cycle_id = ?",
            [cycle.id],
          );
          assert.equal(persisted.length, 1);
          assert.equal(persisted[0].data_quality, "simulated");
          assert.equal(Number(persisted[0].water_liters), 17);
          assert.equal(Number(persisted[0].energy_kwh), 0.75);
        },
      );

      await t.test("duplicate delivery retries a transient refresh failure without another reading or double aggregation", async (subtest) => {
        const before = await rawCount();
        const [[existing]] = await db.query(
          `SELECT reading_value, recorded_at FROM meter_readings WHERE meter_id = ?
           AND source = 'simulation' AND reading_status = 'accepted' ORDER BY recorded_at DESC LIMIT 1`,
          [water.id],
        );
        const calculate = daily.recalculateForReading;
        let attempts = 0;
        subtest.mock.method(daily, "recalculateForReading", async (value) => {
          if (++attempts === 1) throw Object.assign(new Error("Injected transient refresh failure"), { code: "ER_LOCK_DEADLOCK" });
          return calculate(value);
        });
        const result = await simulate(`coasther/meter/${water.meter_uid}/reading`, {
          reading_value: Number(existing.reading_value), recorded_at: existing.recorded_at.toISOString(),
        });
        assert.equal(result.outcome, "duplicate");
        assert.deepEqual(result.metrics_refresh, { status: "refreshed", attempts: 2 });
        assert.equal(await rawCount(), before);
        const [[metric]] = await db.query(
          "SELECT COUNT(*) AS count, MAX(water_liters) AS water_liters FROM daily_coop_metrics WHERE flock_cycle_id = ?", [cycle.id],
        );
        assert.equal(Number(metric.count), 1);
        assert.equal(Number(metric.water_liters), 17);
      });

      await t.test(
        "dashboard defaults hide synthetic data while opt-in simulation remains explicit",
        async () => {
          const normal = await request(
            "GET",
            "/api/dashboard/summary",
            operator.token,
          );
          assert.equal(normal.coop.id, coop.id);
          assert.equal(normal.state, "ready");
          assert.equal(normal.active_cycle.day_age, 1);
          assert.equal(normal.live.power_w, null);
          assert.equal(normal.today.water_liters, null);
          assert.equal(normal.cycle_totals.energy_kwh, null);
          assert.equal("simulation" in normal, false);
          const optedIn = await request(
            "GET",
            "/api/dashboard/summary?include_simulation=true",
            operator.token,
          );
          assert.equal(optedIn.simulation.source, "simulation");
          assert.equal(optedIn.simulation.today.water_liters, 17);
          assert.equal(optedIn.simulation.cycle_totals.energy_kwh, 0.75);
          assert.equal(optedIn.simulation.live.power_w, 110);
          assert.equal(optedIn.simulation.today.data_quality, "simulated");
          await request(
            "GET",
            `/api/dashboard/summary?coop_id=${coop.id}`,
            outsider.token,
            undefined,
            403,
          );
          await request("GET", "/api/dashboard/summary", null, undefined, 401);
          assert.equal(
            (await request("GET", "/api/dashboard/summary", outsider.token))
              .state,
            "no_coop",
          );
          summaryExample = {
            state: optedIn.state,
            local_date: optedIn.local_date,
            active_cycle: {
              day_age: optedIn.active_cycle.day_age,
              current_population: optedIn.active_cycle.current_population,
            },
            live: {
              source: optedIn.live.source,
              status: optedIn.live.status,
              power_w: optedIn.live.power_w,
            },
            simulation: {
              source: optedIn.simulation.source,
              today: {
                water_liters: optedIn.simulation.today.water_liters,
                energy_kwh: optedIn.simulation.today.energy_kwh,
                population_basis: optedIn.simulation.today.population_basis,
                electricity_cost_idr:
                  optedIn.simulation.today.electricity_cost_idr,
                data_quality: optedIn.simulation.today.data_quality,
              },
            },
          };
        },
      );

      await t.test(
        "charts expose local Day 1, null real metrics and optional simulated series",
        async () => {
          const plain = await request(
            "GET",
            "/api/dashboard/charts",
            viewer.token,
          );
          assert.equal(plain.source, "real");
          assert.equal(plain.series.length, 1);
          assert.equal(plain.series[0].water_liters, null);
          const chart = await request(
            "GET",
            `/api/dashboard/charts?coop_id=${coop.id}&metric=water&include_simulation=true`,
            viewer.token,
          );
          assert.equal(chart.timezone, timezone);
          assert.equal(chart.simulation.source, "simulation");
          assert.equal(chart.simulation.series[0].metric_date, today);
          assert.equal(chart.simulation.series[0].day_age, 1);
          assert.equal(chart.simulation.series[0].water_liters, 17);
          assert.equal("energy_kwh" in chart.simulation.series[0], false);
          await request(
            "GET",
            `/api/dashboard/charts?coop_id=${coop.id}`,
            outsider.token,
            undefined,
            403,
          );
          await request(
            "GET",
            "/api/dashboard/charts?range=month",
            operator.token,
            undefined,
            400,
          );
          await request(
            "GET",
            "/api/dashboard/charts?start_date=2026-11-04&end_date=2026-11-03",
            operator.token,
            undefined,
            400,
          );
        },
      );

      await t.test(
        "history defaults to real data and validates source, time bounds and pagination",
        async () => {
          const path = `/api/meters/${water.id}/readings`;
          assert.equal(
            (await request("GET", path, viewer.token)).readings.length,
            0,
          );
          const simulated = await request(
            "GET",
            `${path}?source=simulation`,
            viewer.token,
          );
          assert.equal(simulated.readings.length, 11);
          assert.equal(
            simulated.readings.every((row) => row.source === "simulation"),
            true,
          );
          assert.equal(
            simulated.readings.some(
              (row) => row.reading_status === "out_of_order",
            ),
            true,
          );
          const page1 = await request(
            "GET",
            `${path}?source=all&limit=2`,
            operator.token,
          );
          const page2 = await request(
            "GET",
            `${path}?source=all&limit=2&before_id=${page1.meta.next_before_id}`,
            operator.token,
          );
          assert.equal(page1.readings.length, 2);
          assert.equal(page2.readings.length, 2);
          assert.equal(
            page2.readings.every((row) => row.id < page1.meta.next_before_id),
            true,
          );
          const bounds = `from=${encodeURIComponent(wita(instant()))}&to=${encodeURIComponent(wita(instant(10)))}`;
          assert.equal(
            (
              await request(
                "GET",
                `${path}?source=simulation&${bounds}`,
                operator.token,
              )
            ).readings.length,
            5,
          );
          await request("GET", path, outsider.token, undefined, 403);
          await request("GET", path, null, undefined, 401);
          await request(
            "GET",
            `${path}?limit=501`,
            operator.token,
            undefined,
            400,
          );
          await request(
            "GET",
            `${path}?source=mqtt`,
            operator.token,
            undefined,
            400,
          );
        },
      );

      await t.test(
        "soft-disabled meters and devices stop ingress without deleting history",
        async () => {
          const before = await rawCount();
          await request(
            "DELETE",
            `/api/meters/${water.id}`,
            operator.token,
            undefined,
            403,
          );
          await request("DELETE", `/api/meters/${water.id}`, manager.token);
          assert.equal((await reading(water, 11, 80)).outcome, "disabled");
          assert.equal(await rawCount(), before);
          await request("PATCH", `/api/meters/${water.id}`, manager.token, {
            is_active: true,
          });
          await request("DELETE", `/api/devices/${device.id}`, manager.token);
          assert.equal((await reading(water, 11, 80)).outcome, "disabled");
          const latest = new Date(Math.floor(Date.now() / 1000) * 1000);
          assert.equal(
            (
              await simulate(
                `coasther/telemetry/${device.mqtt_topic_key}/live`,
                { recorded_at: wita(latest), power: 999 },
              )
            ).outcome,
            "disabled",
          );
          assert.equal(await rawCount(), before);
          assert.equal(
            (await request("GET", `/api/devices/${device.id}`, viewer.token))
              .device.connectivity_status,
            "disabled",
          );
          assert.equal(
            (
              await request(
                "GET",
                `/api/meters/${water.id}/readings?source=simulation`,
                viewer.token,
              )
            ).readings.length,
            11,
          );
        },
      );
    } finally {
      for (const client of clients) client.disconnect();
      if (io) await new Promise((resolve) => io.close(resolve));
      else if (server) await new Promise((resolve) => server.close(resolve));
      try {
        await cleanup();
        const [[leftovers]] = await db.query(
          "SELECT COUNT(*) AS count FROM users WHERE email IN (?)",
          [emails.length ? emails : ["no-fixture"]],
        );
        assert.equal(Number(leftovers.count), 0);
      } finally {
        await db.end();
      }
    }
    if (summaryExample)
      t.diagnostic(
        `Sanitized simulated dashboard example: ${JSON.stringify(summaryExample)}`,
      );
  },
);
