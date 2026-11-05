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
  throw new Error(
    "Forecast tests require imported development coasther_broiler",
  );
process.env.NODE_ENV = "test";
process.env.JWT_SECRET ||= crypto.randomBytes(32).toString("hex");
const db = require("../src/config/db");
const { localDate } = require("../src/utils/farmDate");
const { calendarBoundary } = require("../src/services/dailyMetrics.service");
const logger = require("../src/config/logger");
for (const transport of logger.transports) transport.silent = true;

test(
  "Forecast deterministic HTTP, source isolation, history and cache on owned multi-day simulation",
  { timeout: 60000 },
  async (t) => {
    const marker = `forecast-test-${crypto.randomUUID()}`;
    const users = [];
    const meters = [];
    const members = [];
    const today = localDate("Asia/Makassar");
    const shift = (n) =>
      new Date(Date.parse(today) + n * 86400000).toISOString().slice(0, 10);
    let farmId, coopId, cycleId, deviceId, waterId, energyId, server, base;
    let manager, operator, outsider;
    async function account(role) {
      const [result] = await db.query(
        "INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?,?)",
        [
          marker,
          `${marker}-${users.length}@example.invalid`,
          "!unusable-forecast-fixture-hash",
          role,
        ],
      );
      users.push(result.insertId);
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
      const value = await response.json();
      assert.equal(
        response.status,
        expected,
        `${method} ${path}: ${JSON.stringify(value)}`,
      );
      return value.data;
    }
    async function insertReading(
      meterId,
      at,
      counter,
      delta,
      status = "accepted",
    ) {
      const [result] = await db.query(
        `INSERT INTO meter_readings (meter_id,coop_id,flock_cycle_id,reading_value,delta_value,reading_status,source,recorded_at)
       VALUES (?,?,?,?,?,?,'simulation',?)`,
        [meterId, coopId, cycleId, counter, delta, status, at],
      );
      return result.insertId;
    }
    const projection = (value, metric, horizon = "next_day") =>
      value.forecasts.find(
        (row) => row.metric === metric && row.horizon === horizon,
      );
    try {
      manager = await account("manager");
      operator = await account("operator");
      outsider = await account("operator");
      const connection = await db.getConnection();
      try {
        await connection.beginTransaction();
        const [farm] = await connection.query(
          "INSERT INTO farms (owner_user_id,name,electricity_rate_idr_per_kwh,water_rate_idr_per_m3) VALUES (?,?,1500,2000)",
          [manager.id, marker],
        );
        farmId = farm.insertId;
        for (const [user, role] of [
          [manager, "owner"],
          [operator, "operator"],
        ]) {
          const [row] = await connection.query(
            "INSERT INTO farm_members (farm_id,user_id,role) VALUES (?,?,?)",
            [farmId, user.id, role],
          );
          members.push(row.insertId);
        }
        const [coop] = await connection.query(
          "INSERT INTO coops (farm_id,code,name) VALUES (?,?,?)",
          [farmId, "FORECAST-01", marker],
        );
        coopId = coop.insertId;
        const [cycle] = await connection.query(
          "INSERT INTO flock_cycles (coop_id,cycle_code,placement_date,planned_harvest_date,initial_population,current_population,status) VALUES (?,?,?,?,100,60,'active')",
          [coopId, "FORECAST-CYCLE", shift(-3), shift(3)],
        );
        cycleId = cycle.insertId;
        await connection.query(
          "INSERT INTO flock_events (flock_cycle_id,event_type,population_change,event_date,notes,recorded_by) VALUES (?,'mortality',-40,?,?,?)",
          [cycleId, shift(-1), "Synthetic management fixture", manager.id],
        );
        const [device] = await connection.query(
          "INSERT INTO devices (coop_id,device_uid,mqtt_topic_key,name) VALUES (?,?,?,?)",
          [coopId, marker, marker, marker],
        );
        deviceId = device.insertId;
        for (const [type, unit] of [
          ["water", "liter"],
          ["electricity", "kwh"],
        ]) {
          const [meter] = await connection.query(
            "INSERT INTO meters (device_id,meter_uid,type,unit) VALUES (?,?,?,?)",
            [deviceId, `${marker}-${type}`, type, unit],
          );
          meters.push(meter.insertId);
          if (type === "water") waterId = meter.insertId;
          else energyId = meter.insertId;
        }
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
      for (const meter of meters)
        await insertReading(
          meter,
          new Date(
            calendarBoundary(shift(-3), "Asia/Makassar").getTime() + 60000,
          ),
          0,
          0,
          "baseline",
        );
      let waterCounter = 0,
        energyCounter = 0;
      for (const [offset, water, energy] of [
        [-3, 100, 5],
        [-2, 200, 10],
        [-1, 120, 6],
      ]) {
        const at = new Date(
          calendarBoundary(shift(offset), "Asia/Makassar").getTime() +
            12 * 3600000,
        );
        waterCounter += water;
        energyCounter += energy;
        await insertReading(waterId, at, waterCounter, water);
        await insertReading(energyId, at, energyCounter, energy);
      }
      const app = express();
      app.use(express.json());
      app.use("/api/forecasts", require("../src/routes/forecast.routes"));
      app.use(require("../src/middlewares/error.middleware"));
      server = app.listen(0, "127.0.0.1");
      await new Promise((resolve) => server.once("listening", resolve));
      base = `http://127.0.0.1:${server.address().port}`;
      let first;

      await t.test(
        "real missing data stays insufficient, JWT/farm permissions hold, and simulation source is opt-in",
        async () => {
          await request(
            "GET",
            `/api/forecasts/current?coop_id=${coopId}`,
            null,
            undefined,
            401,
          );
          await request(
            "GET",
            `/api/forecasts/current?coop_id=${coopId}`,
            outsider,
            undefined,
            403,
          );
          const real = await request(
            "GET",
            `/api/forecasts/current?coop_id=${coopId}`,
            operator,
          );
          assert.equal(real.state, "insufficient_data");
          assert.equal(real.source, "real");
          assert.equal(real.forecasts.length, 0);
          assert.equal(real.observed_days.water_liters, 0);
          await request(
            "POST",
            "/api/forecasts/generate",
            operator,
            { coop_id: coopId, source: "simulation" },
            403,
          );
          await request(
            "POST",
            "/api/forecasts/generate",
            manager,
            { coop_id: coopId, horizon: "next_7_days" },
            400,
          );
        },
      );

      await t.test(
        "three closed simulated dates produce six correctly normalized persisted rows",
        async () => {
          first = await request(
            "GET",
            `/api/forecasts/current?coop_id=${coopId}&source=simulation`,
            operator,
          );
          assert.equal(first.state, "low_confidence");
          assert.equal(first.forecasts.length, 6);
          assert.equal(first.is_simulated, true);
          assert.equal(first.eligible_days.water_liters, 3);
          assert.equal(first.population_basis, 60);
          assert.equal(projection(first, "water_liters").predicted_value, 100);
          assert.equal(projection(first, "energy_kwh").predicted_value, 5);
          assert.equal(
            projection(first, "electricity_cost_idr").predicted_value,
            7500,
          );
          assert.equal(
            projection(first, "water_liters", "until_harvest").predicted_value,
            300,
          );
          assert.equal(
            projection(first, "water_liters", "until_harvest").details_json
              .estimated_water_cost_idr,
            600,
          );
          const [stored] = await db.query(
            "SELECT id,is_simulated,method,confidence,input_days FROM forecasts WHERE coop_id=?",
            [coopId],
          );
          assert.equal(stored.length, 6);
          assert.ok(
            stored.every(
              (row) =>
                row.is_simulated === 1 &&
                row.method === "moving_average" &&
                row.confidence === "low" &&
                row.input_days === 3,
            ),
          );
          const [[device]] = await db.query(
            "SELECT last_seen_at FROM devices WHERE id=?",
            [deviceId],
          );
          assert.equal(device.last_seen_at, null);
          const [physical] = await db.query(
            "SELECT last_reading_at,last_reading_value,counter_epoch FROM meters WHERE device_id=?",
            [deviceId],
          );
          assert.ok(
            physical.every(
              (row) =>
                row.last_reading_at == null &&
                row.last_reading_value == null &&
                row.counter_epoch === 0,
            ),
          );
        },
      );

      await t.test(
        "concurrent GET/POST and changing current-day evidence reuse forecast IDs and refresh metadata",
        async () => {
          const calls = await Promise.allSettled([
            request("GET", "/api/forecasts/current?source=simulation", manager),
            request("POST", "/api/forecasts/generate", manager, {
              coop_id: coopId,
              source: "simulation",
            }),
          ]);
          for (const result of calls) {
            if (result.status === "rejected") throw result.reason;
            assert.deepEqual(
              result.value.forecasts.map((row) => row.id),
              first.forecasts.map((row) => row.id),
            );
          }
          const at = new Date(
            Math.max(
              calendarBoundary(today, "Asia/Makassar").getTime(),
              Date.now() - 1000,
            ),
          );
          await insertReading(waterId, at, 440, 20);
          await insertReading(
            waterId,
            new Date(Date.now() + 120000),
            1439,
            999,
          );
          const current = await request(
            "GET",
            `/api/forecasts/current?coop_id=${coopId}&source=simulation`,
            operator,
          );
          assert.equal(current.observed_days.water_liters, 4);
          assert.equal(current.eligible_days.water_liters, 3);
          assert.deepEqual(
            current.forecasts.map((row) => row.id),
            first.forecasts.map((row) => row.id),
          );
          assert.equal(current.cache_status, "reused_same_inputs");
          const [[{ count }]] = await db.query(
            "SELECT COUNT(*) AS count FROM forecasts WHERE coop_id=?",
            [coopId],
          );
          assert.equal(count, 6);
        },
      );

      await t.test(
        "current tariffs and population events invalidate inputs while preserving append-only history",
        async () => {
          await db.query(
            "UPDATE farms SET electricity_rate_idr_per_kwh=2000 WHERE id=? AND name=?",
            [farmId, marker],
          );
          const tariff = await request(
            "GET",
            `/api/forecasts/current?coop_id=${coopId}&source=simulation`,
            manager,
          );
          assert.equal(
            projection(tariff, "electricity_cost_idr").predicted_value,
            10000,
          );
          assert.notEqual(tariff.input_fingerprint, first.input_fingerprint);
          const connection = await db.getConnection();
          try {
            await connection.beginTransaction();
            await connection.query(
              "INSERT INTO flock_events (flock_cycle_id,event_type,population_change,event_date,notes,recorded_by) VALUES (?,'adjustment',-10,?,?,?)",
              [
                cycleId,
                today,
                "Synthetic counted population correction",
                manager.id,
              ],
            );
            await connection.query(
              "UPDATE flock_cycles SET current_population=50 WHERE id=? AND coop_id=?",
              [cycleId, coopId],
            );
            await connection.commit();
          } catch (error) {
            await connection.rollback();
            throw error;
          } finally {
            connection.release();
          }
          const population = await request(
            "GET",
            `/api/forecasts/current?coop_id=${coopId}&source=simulation`,
            manager,
          );
          assert.equal(population.population_basis, 50);
          assert.equal(
            projection(population, "water_liters").predicted_value,
            83.3333,
          );
          const history = await request(
            "GET",
            `/api/forecasts/history?coop_id=${coopId}&source=simulation&metric=water_liters&horizon=next_day&limit=2`,
            operator,
          );
          assert.equal(history.meta.total, 3);
          assert.equal(history.forecasts.length, 2);
          assert.ok(
            history.forecasts.every(
              (row) => row.source === "simulation" && row.is_simulated,
            ),
          );
          assert.equal(
            (
              await request(
                "GET",
                `/api/forecasts/history?coop_id=${coopId}`,
                manager,
              )
            ).forecasts.length,
            0,
          );
          await request(
            "GET",
            `/api/forecasts/history?coop_id=${coopId}&source=simulation`,
            outsider,
            undefined,
            403,
          );
        },
      );

      await t.test(
        "unrealistic planned harvest is reported without mutation while tomorrow remains usable",
        async () => {
          const bad = shift(100);
          await db.query(
            "UPDATE flock_cycles SET planned_harvest_date=? WHERE id=? AND coop_id=?",
            [bad, cycleId, coopId],
          );
          const result = await request(
            "GET",
            `/api/forecasts/current?coop_id=${coopId}&source=simulation`,
            manager,
          );
          assert.equal(
            result.horizons.until_harvest.state,
            "invalid_harvest_horizon",
          );
          assert.equal(result.forecasts.length, 3);
          assert.ok(
            result.forecasts.every((row) => row.horizon === "next_day"),
          );
          const [[stored]] = await db.query(
            "SELECT DATE_FORMAT(planned_harvest_date,'%Y-%m-%d') AS planned FROM flock_cycles WHERE id=?",
            [cycleId],
          );
          assert.equal(stored.planned, bad);
        },
      );

      await t.test(
        "history survives completion and revoked readers cannot access stored forecasts",
        async () => {
          await db.query(
            "UPDATE flock_cycles SET status='completed',actual_harvest_date=? WHERE id=? AND coop_id=?",
            [today, cycleId, coopId],
          );
          const result = await request(
            "GET",
            `/api/forecasts/current?coop_id=${coopId}&source=simulation`,
            manager,
          );
          assert.equal(result.state, "no_active_cycle");
          assert.equal(result.forecasts.length, 0);
          const history = await request(
            "GET",
            `/api/forecasts/history?coop_id=${coopId}&source=simulation&flock_cycle_id=${cycleId}`,
            operator,
          );
          assert.ok(history.meta.total >= 18);
          await db.query("DELETE FROM farm_members WHERE id=? AND user_id=?", [
            members[1],
            operator.id,
          ]);
          await request(
            "GET",
            `/api/forecasts/history?coop_id=${coopId}&source=simulation`,
            operator,
            undefined,
            403,
          );
        },
      );
    } finally {
      if (server) await new Promise((resolve) => server.close(resolve));
      if (coopId) {
        const [cache] = await db.query(
          "SELECT id FROM ai_cache WHERE coop_id=?",
          [coopId],
        );
        const [forecasts] = await db.query(
          "SELECT id FROM forecasts WHERE coop_id=?",
          [coopId],
        );
        const [readings] = await db.query(
          "SELECT id FROM meter_readings WHERE coop_id=? AND source='simulation'",
          [coopId],
        );
        for (const row of cache)
          await db.query("DELETE FROM ai_cache WHERE id=? AND coop_id=?", [
            row.id,
            coopId,
          ]);
        for (const row of forecasts)
          await db.query("DELETE FROM forecasts WHERE id=? AND coop_id=?", [
            row.id,
            coopId,
          ]);
        for (const row of readings)
          await db.query(
            "DELETE FROM meter_readings WHERE id=? AND source='simulation'",
            [row.id],
          );
        if (cycleId) {
          const [events] = await db.query(
            "SELECT id FROM flock_events WHERE flock_cycle_id=?",
            [cycleId],
          );
          for (const row of events)
            await db.query(
              "DELETE FROM flock_events WHERE id=? AND flock_cycle_id=?",
              [row.id, cycleId],
            );
        }
        for (const id of meters)
          await db.query("DELETE FROM meters WHERE id=? AND device_id=?", [
            id,
            deviceId,
          ]);
        if (deviceId)
          await db.query("DELETE FROM devices WHERE id=? AND device_uid=?", [
            deviceId,
            marker,
          ]);
        if (cycleId)
          await db.query("DELETE FROM flock_cycles WHERE id=? AND coop_id=?", [
            cycleId,
            coopId,
          ]);
        await db.query("DELETE FROM coops WHERE id=? AND name=?", [
          coopId,
          marker,
        ]);
      }
      for (const id of members)
        await db.query("DELETE FROM farm_members WHERE id=? AND farm_id=?", [
          id,
          farmId,
        ]);
      if (farmId)
        await db.query("DELETE FROM farms WHERE id=? AND name=?", [
          farmId,
          marker,
        ]);
      for (const id of users)
        await db.query("DELETE FROM users WHERE id=? AND name=?", [id, marker]);
      await db.end();
    }
  },
);
