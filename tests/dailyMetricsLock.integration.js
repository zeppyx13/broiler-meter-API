require("dotenv").config({ quiet: true });
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

if (process.env.NODE_ENV === "production" || process.env.DB_NAME !== "coasther_broiler") {
  throw new Error("Lock regression tests require the imported development coasther_broiler database");
}

const db = require("../src/config/db");
const access = require("../src/services/access.service");
const accessModel = require("../src/models/access.model");
const metricsModel = require("../src/models/dailyMetrics.model");
const metrics = require("../src/services/dailyMetrics.service");
const iot = require("../src/models/iotBroiler.model");
const { localDate } = require("../src/utils/farmDate");

test("Metrics lock order against ingestion, using isolated management fixtures without telemetry", { timeout: 30000 }, async (t) => {
  const marker = `metrics-lock-${crypto.randomUUID()}`;
  const ids = {};
  const date = localDate("Asia/Makassar");
  async function insert(key, sql, params) {
    const [result] = await db.query(sql, params);
    ids[key] = result.insertId;
  }
  try {
    await insert("user", "INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?,'operator')", [marker, `${marker}@example.invalid`, "!unusable-lock-test-hash"]);
    await insert("farm", "INSERT INTO farms (owner_user_id,name,timezone) VALUES (?,?,'Asia/Makassar')", [ids.user, marker]);
    await insert("member", "INSERT INTO farm_members (farm_id,user_id,role) VALUES (?,?,'owner')", [ids.farm, ids.user]);
    await insert("coop", "INSERT INTO coops (farm_id,code,name) VALUES (?,?,?)", [ids.farm, "LOCK-01", marker]);
    await insert("cycle", "INSERT INTO flock_cycles (coop_id,cycle_code,placement_date,initial_population,current_population,status) VALUES (?,?,?,100,100,'active')", [ids.coop, "LOCK-CYCLE", date]);
    await insert("device", "INSERT INTO devices (coop_id,device_uid,mqtt_topic_key,name) VALUES (?,?,?,?)", [ids.coop, marker, marker, marker]);
    await insert("meter", "INSERT INTO meters (device_id,meter_uid,type,unit) VALUES (?,?,'water','liter')", [ids.device, marker]);

    async function waitUntilBlocked(connectionId) {
      for (let attempt = 0; attempt < 200; attempt++) {
        const [rows] = await db.query(
          `SELECT w.requesting_trx_id FROM information_schema.INNODB_LOCK_WAITS w
           JOIN information_schema.INNODB_TRX tr ON tr.trx_id = w.requesting_trx_id
           WHERE tr.trx_mysql_thread_id = ?`, [connectionId],
        );
        if (rows.length) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.fail("Expected the metrics connection to wait for the ingestion parent lock");
    }

    async function connections(work) {
      const a = await db.getConnection();
      const b = await db.getConnection();
      try {
        await a.query("SET SESSION innodb_lock_wait_timeout = 5");
        await b.query("SET SESSION innodb_lock_wait_timeout = 5");
        const [[{ id }]] = await b.query("SELECT CONNECTION_ID() AS id");
        await work(a, b, id);
      } finally {
        await Promise.allSettled([a.rollback(), b.rollback()]);
        a.release();
        b.release();
      }
    }

    await t.test("Previous locking context lookup reproduces a deadlock against the ingestion parent lock", async () => {
        await connections(async (a, b, connectionId) => {
          await a.beginTransaction();
          await b.beginTransaction();
          await accessModel.lockFarm(ids.farm, a);
          // Recreate the previous call order, without inserting or changing readings.
          const lookup = metricsModel.cycleById(ids.cycle, b).then(() => null, (error) => error.code);
          await waitUntilBlocked(connectionId);
          const ingestion = await iot.cycles(ids.coop, a).then(() => null, (error) => error.code);
          const context = await lookup;
          assert.ok([ingestion, context].includes("ER_LOCK_DEADLOCK"));
        });
    });

    for (const readingRefresh of [false, true]) {
      await t.test(`Fixed ${readingRefresh ? "reading refresh" : "cycle recalculation"} waits without locking the cycle first`, async (subtest) => {
        await connections(async (a, b) => {
          await a.beginTransaction();
          await access.lockCoop(a, ids.coop);
          await iot.lockDevice(ids.device, a);
          await iot.lockMeter(ids.meter, a);
          const wrapped = {
            query: b.query.bind(b), beginTransaction: b.beginTransaction.bind(b),
            commit: b.rollback.bind(b), rollback: b.rollback.bind(b), release() {},
          };
          let signalParentAttempt;
          const parentAttempt = new Promise((resolve) => { signalParentAttempt = resolve; });
          const originalLockFarm = accessModel.lockFarm;
          subtest.mock.method(accessModel, "lockFarm", async (id, connection) => {
            if (connection === wrapped) signalParentAttempt();
            return originalLockFarm(id, connection);
          });
          // Even cache writes would roll back; this fixture intentionally has no readings.
          subtest.mock.method(db, "getConnection", async () => wrapped);
          const result = (readingRefresh
            ? metrics.recalculateForReading({ coop_id: ids.coop, flock_cycle_id: ids.cycle, recorded_at: new Date() })
            : metrics.recalculateCycle({ flock_cycle_id: ids.cycle, start_date: date, end_date: date }))
            .then((value) => ({ value }), (error) => ({ error: error.code || error.name }));
          let waitTimer;
          let assertionError;
          try {
            await Promise.race([
              parentAttempt,
              new Promise((resolve, reject) => { waitTimer = setTimeout(() => reject(new Error("Metrics tried a locking context read before reaching the parent lock")), 1500); }),
            ]);
            const cycles = await iot.cycles(ids.coop, a);
            assert.equal(cycles.length, 1);
          } catch (error) {
            assertionError = error;
          } finally {
            clearTimeout(waitTimer);
            await a.rollback();
          }
          const completed = await result;
          if (assertionError) throw assertionError;
          assert.equal(completed.error, undefined);
          assert.equal(completed.value.real.length, 1);
          assert.equal(completed.value.real[0].water_liters, null);
        });
      });
    }
    const [[{ count }]] = await db.query("SELECT COUNT(*) AS count FROM meter_readings WHERE coop_id = ?", [ids.coop]);
    assert.equal(count, 0);
  } finally {
    if (ids.meter) await db.query("DELETE FROM meters WHERE id = ? AND meter_uid = ?", [ids.meter, marker]);
    if (ids.device) await db.query("DELETE FROM devices WHERE id = ? AND device_uid = ?", [ids.device, marker]);
    if (ids.cycle) await db.query("DELETE FROM flock_cycles WHERE id = ? AND coop_id = ?", [ids.cycle, ids.coop]);
    if (ids.coop) await db.query("DELETE FROM coops WHERE id = ? AND name = ?", [ids.coop, marker]);
    if (ids.member) await db.query("DELETE FROM farm_members WHERE id = ? AND farm_id = ?", [ids.member, ids.farm]);
    if (ids.farm) await db.query("DELETE FROM farms WHERE id = ? AND name = ?", [ids.farm, marker]);
    if (ids.user) await db.query("DELETE FROM users WHERE id = ? AND email = ?", [ids.user, `${marker}@example.invalid`]);
    await db.end();
  }
});
