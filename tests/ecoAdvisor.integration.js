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
    "Eco integration requires the imported development coasther_broiler database",
  );
}
process.env.NODE_ENV = "test";
process.env.JWT_SECRET ||= crypto.randomBytes(32).toString("hex");
const db = require("../src/config/db");
const users = require("../src/models/user.model");
const farms = require("../src/services/farm.service");
const farmSchema = require("../src/validators/farm.validator");
const coops = require("../src/services/coop.service");
const coopSchema = require("../src/validators/coop.validator");
const flocks = require("../src/services/flockCycle.service");
const flockSchema = require("../src/validators/flockCycle.validator");
const devices = require("../src/services/device.service");
const deviceSchema = require("../src/validators/device.validator");
const meters = require("../src/services/meterBroiler.service");
const meterSchema = require("../src/validators/meterBroiler.validator");
const ingestion = require("../src/services/iotBroiler.service");
const { verify } = require("../src/services/schemaCompatibility.service");
const { localDate } = require("../src/utils/farmDate");
const logger = require("../src/config/logger");
for (const transport of logger.transports) transport.silent = true;

test(
  "Eco HTTP domain uses accepted simulation evidence, persists idempotently and enforces access",
  { timeout: 45000 },
  async (t) => {
    const marker = `eco-test-${crypto.randomUUID()}`;
    const userIds = [];
    const farmIds = [];
    let owner,
      operator,
      viewer,
      outsider,
      farm,
      coop,
      cycle,
      device,
      water,
      energy,
      server,
      base;
    const today = localDate("Asia/Makassar");
    const date = (offset) =>
      new Date(Date.parse(today) + offset * 86400000)
        .toISOString()
        .slice(0, 10);
    const app = express();
    app.use(express.json());
    app.use(
      "/api/eco-recommendations",
      require("../src/routes/ecoAdvisor.routes"),
    );
    app.use(require("../src/middlewares/error.middleware"));

    async function account(label, role) {
      const id = await users.createUser({
        name: `${marker}-${label}`,
        email: `${marker}-${label}@example.invalid`,
        role,
        password_hash: await bcrypt.hash(
          crypto.randomBytes(16).toString("hex"),
          4,
        ),
      });
      userIds.push(id);
      return {
        ...(await users.findById(id)),
        token: jwt.sign({ id, role }, process.env.JWT_SECRET, {
          expiresIn: "1h",
        }),
      };
    }
    async function request(method, path, user, body, expected = 200) {
      const response = await fetch(`${base}/api/eco-recommendations${path}`, {
        method,
        headers: {
          ...(user ? { Authorization: `Bearer ${user.token}` } : {}),
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const payload = await response.json();
      assert.equal(
        response.status,
        expected,
        `${method} ${path}: ${JSON.stringify(payload)}`,
      );
      return payload.data;
    }
    async function reading(meter, value, recordedAt) {
      const result = await ingestion.handleMessage(
        `coasther/meter/${meter.meter_uid}/reading`,
        Buffer.from(
          JSON.stringify({
            reading_value: value,
            recorded_at: recordedAt,
          }),
        ),
        { source: "simulation", receivedAt: new Date() },
      );
      assert.equal(result.outcome, "stored");
      return result;
    }
    async function cleanup() {
      const [ownFarms] = farmIds.length
        ? await db.query(
            "SELECT id FROM farms WHERE id IN (?) AND name LIKE ?",
            [farmIds, `${marker}%`],
          )
        : [[]];
      const farmsToDelete = ownFarms.map((row) => row.id);
      const [ownCoops] = farmsToDelete.length
        ? await db.query("SELECT id FROM coops WHERE farm_id IN (?)", [
            farmsToDelete,
          ])
        : [[]];
      const coopIds = ownCoops.map((row) => row.id);
      const [ownCycles] = coopIds.length
        ? await db.query("SELECT id FROM flock_cycles WHERE coop_id IN (?)", [
            coopIds,
          ])
        : [[]];
      const cycleIds = ownCycles.map((row) => row.id);
      const [ownDevices] = coopIds.length
        ? await db.query("SELECT id FROM devices WHERE coop_id IN (?)", [
            coopIds,
          ])
        : [[]];
      const deviceIds = ownDevices.map((row) => row.id);
      const [ownMeters] = deviceIds.length
        ? await db.query("SELECT id FROM meters WHERE device_id IN (?)", [
            deviceIds,
          ])
        : [[]];
      const meterIds = ownMeters.map((row) => row.id);
      const [ownReadings] = coopIds.length
        ? await db.query("SELECT id FROM meter_readings WHERE coop_id IN (?)", [
            coopIds,
          ])
        : [[]];
      const readingIds = ownReadings.map((row) => row.id);
      const [ownMetrics] = coopIds.length
        ? await db.query(
            "SELECT id FROM daily_coop_metrics WHERE coop_id IN (?)",
            [coopIds],
          )
        : [[]];
      const metricIds = ownMetrics.map((row) => row.id);
      const [ownAdvice] = coopIds.length
        ? await db.query(
            "SELECT id FROM eco_recommendations WHERE coop_id IN (?)",
            [coopIds],
          )
        : [[]];
      const adviceIds = ownAdvice.map((row) => row.id);
      const [ownMembers] = farmsToDelete.length
        ? await db.query("SELECT id FROM farm_members WHERE farm_id IN (?)", [
            farmsToDelete,
          ])
        : [[]];
      const memberIds = ownMembers.map((row) => row.id);
      const connection = await db.getConnection();
      try {
        await connection.beginTransaction();
        if (adviceIds.length)
          await connection.query(
            "DELETE FROM eco_recommendations WHERE id IN (?)",
            [adviceIds],
          );
        if (metricIds.length)
          await connection.query(
            "DELETE FROM daily_coop_metrics WHERE id IN (?)",
            [metricIds],
          );
        if (readingIds.length)
          await connection.query("DELETE FROM meter_readings WHERE id IN (?)", [
            readingIds,
          ]);
        if (meterIds.length)
          await connection.query("DELETE FROM meters WHERE id IN (?)", [
            meterIds,
          ]);
        if (deviceIds.length)
          await connection.query("DELETE FROM devices WHERE id IN (?)", [
            deviceIds,
          ]);
        if (cycleIds.length)
          await connection.query("DELETE FROM flock_cycles WHERE id IN (?)", [
            cycleIds,
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
        if (farmsToDelete.length)
          await connection.query("DELETE FROM farms WHERE id IN (?)", [
            farmsToDelete,
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
      assert.equal((await verify()).verified_tables, 21);
      owner = await account("owner", "manager");
      operator = await account("operator", "operator");
      viewer = await account("viewer", "operator");
      outsider = await account("outsider", "operator");
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
            code: "E1",
            name: "Eco fixture coop",
            capacity_birds: 100,
          }),
        )
      ).coop;
      cycle = await flocks.create(
        owner,
        flockSchema.createSchema.parse({
          coop_id: coop.id,
          cycle_code: "ECO",
          placement_date: date(-4),
          initial_population: 100,
        }),
      );
      device = (
        await devices.create(
          owner,
          deviceSchema.createSchema.parse({
            coop_id: coop.id,
            device_uid: `${marker}-device`,
            mqtt_topic_key: marker,
            name: "Synthetic Eco device",
          }),
        )
      ).device;
      water = (
        await meters.create(
          owner,
          meterSchema.createSchema.parse({
            device_id: device.id,
            meter_uid: `${marker}-water`,
            type: "water",
            unit: "liter",
          }),
        )
      ).meter;
      energy = (
        await meters.create(
          owner,
          meterSchema.createSchema.parse({
            device_id: device.id,
            meter_uid: `${marker}-energy`,
            type: "electricity",
            unit: "kwh",
          }),
        )
      ).meter;
      server = app.listen(0, "127.0.0.1");
      await new Promise((resolve) => server.once("listening", resolve));
      base = `http://127.0.0.1:${server.address().port}`;

      await t.test(
        "empty real history yields labeled collection guidance and polling is bounded",
        async () => {
          await request("GET", "", null, undefined, 401);
          await request("GET", `?coop_id=${coop.id}`, outsider, undefined, 403);
          const first = await request("GET", `?coop_id=${coop.id}`, viewer);
          const second = await request("GET", `?coop_id=${coop.id}`, viewer);
          assert.equal(first.state, "insufficient_data");
          assert.equal(first.recommendations[0].source, "rule");
          assert.equal(first.recommendations[0].estimated_savings_idr, null);
          assert.equal(
            first.recommendations[0].id,
            second.recommendations[0].id,
          );
          assert.equal(first.meta.total, 1);
          await request(
            "POST",
            "/generate",
            operator,
            { coop_id: coop.id },
            403,
          );
          await request("POST", "/generate", viewer, { coop_id: coop.id }, 403);
        },
      );

      await t.test(
        "four closed simulation dates create explainable same-cycle water/panel advice with concurrent dedupe",
        async () => {
          let waterValue = 0;
          let energyValue = 0;
          for (const offset of [-4, -3, -2, -1]) {
            await reading(water, waterValue, `${date(offset)}T08:00:00+08:00`);
            await reading(
              energy,
              energyValue,
              `${date(offset)}T08:00:00+08:00`,
            );
            waterValue += offset === -1 ? 200 : 100;
            energyValue += offset === -1 ? 20 : 10;
            await reading(water, waterValue, `${date(offset)}T09:00:00+08:00`);
            await reading(
              energy,
              energyValue,
              `${date(offset)}T09:00:00+08:00`,
            );
          }
          const results = await Promise.all([
            request("POST", "/generate", owner, {
              coop_id: coop.id,
              source: "simulation",
            }),
            request("POST", "/generate", owner, {
              coop_id: coop.id,
              source: "simulation",
            }),
          ]);
          assert.deepEqual(
            results.map((row) => row.created_count).sort(),
            [0, 2],
          );
          assert.equal(
            results.every((row) => row.state === "ready"),
            true,
          );
          assert.equal(
            results[0].recommendations.every(
              (row) =>
                row.source === "simulation" &&
                row.is_simulated &&
                row.estimated_savings_idr === null,
            ),
            true,
          );
          const waterAdvice = results[0].recommendations.find(
            (row) => row.category === "water",
          );
          assert.equal(waterAdvice.evidence_json.baseline_per_bird, 1);
          assert.equal(waterAdvice.evidence_json.latest_per_bird, 2);
          assert.equal(waterAdvice.evidence_json.change_percent, 100);
          const real = await request("GET", `?coop_id=${coop.id}`, owner);
          assert.equal(real.state, "insufficient_data");
          assert.deepEqual(real.observed_days, { water: 0, electricity: 0 });
          assert.equal(
            real.recommendations.every((row) => row.source === "rule"),
            true,
          );
        },
      );

      await t.test(
        "manual accepted/dismissed status is scoped, audited and preserved across generation",
        async () => {
          const list = await request(
            "GET",
            `?coop_id=${coop.id}&source=simulation`,
            viewer,
          );
          assert.equal(list.meta.total, 2);
          const id = list.recommendations[0].id;
          await request(
            "PATCH",
            `/${id}/status`,
            viewer,
            { status: "accepted" },
            403,
          );
          await request(
            "PATCH",
            `/${id}/status`,
            outsider,
            { status: "accepted" },
            403,
          );
          const accepted = await request("PATCH", `/${id}/status`, operator, {
            status: "accepted",
          });
          assert.equal(accepted.recommendation.status, "accepted");
          assert.equal(
            accepted.recommendation.evidence_json.interaction.user_id,
            operator.id,
          );
          const regenerated = await request("POST", "/generate", owner, {
            coop_id: coop.id,
            source: "simulation",
          });
          assert.equal(regenerated.created_count, 0);
          assert.equal(
            regenerated.recommendations.find((row) => row.id === id).status,
            "accepted",
          );
          const filtered = await request(
            "GET",
            `?coop_id=${coop.id}&source=simulation&status=accepted&limit=1`,
            operator,
          );
          assert.equal(filtered.meta.total, 1);
          await request("PATCH", `/${id}/status`, operator, {
            status: "dismissed",
          });
          await request(
            "PATCH",
            `/${id}/status`,
            operator,
            { status: "new" },
            400,
          );
        },
      );

      await t.test(
        "accepted-zero churn and large partial-today consumption cannot duplicate/change closed-day advice",
        async () => {
          await reading(water, 500, `${date(-1)}T10:00:00+08:00`);
          await reading(
            water,
            10000,
            new Date(Math.floor(Date.now() / 1000) * 1000).toISOString(),
          );
          const result = await request("POST", "/generate", owner, {
            coop_id: coop.id,
            source: "simulation",
          });
          assert.equal(result.created_count, 0);
          assert.equal(
            result.recommendations.find((row) => row.category === "water")
              .evidence_json.latest_per_bird,
            2,
          );
          const [[physical]] = await db.query(
            "SELECT last_seen_at FROM devices WHERE id = ?",
            [device.id],
          );
          assert.equal(physical.last_seen_at, null);
          const [physicalMeters] = await db.query(
            "SELECT last_reading_value FROM meters WHERE device_id = ?",
            [device.id],
          );
          assert.equal(
            physicalMeters.every((row) => row.last_reading_value == null),
            true,
          );
          const [[records]] = await db.query(
            "SELECT COUNT(*) AS count FROM eco_recommendations WHERE coop_id = ?",
            [coop.id],
          );
          assert.equal(Number(records.count), 3);
        },
      );

      await t.test(
        "revocation blocks every Eco path and request inputs cannot request side effects",
        async () => {
          await request(
            "POST",
            "/generate",
            owner,
            { coop_id: coop.id, source: "mqtt" },
            400,
          );
          await request(
            "POST",
            "/generate",
            owner,
            { coop_id: coop.id, relay_id: 1 },
            400,
          );
          await farms.changeMember(owner, farm.id, operator.id, null, "remove");
          await request("GET", `?coop_id=${coop.id}`, operator, undefined, 403);
          const [[row]] = await db.query(
            "SELECT id FROM eco_recommendations WHERE coop_id = ? ORDER BY id LIMIT 1",
            [coop.id],
          );
          await request(
            "PATCH",
            `/${row.id}/status`,
            operator,
            { status: "accepted" },
            403,
          );
        },
      );
    } finally {
      if (server) await new Promise((resolve) => server.close(resolve));
      try {
        await cleanup();
      } finally {
        await db.end();
      }
    }
  },
);
