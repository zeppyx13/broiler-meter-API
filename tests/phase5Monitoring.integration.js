require("dotenv").config({ quiet: true });
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const database = process.env.BROILER_TEST_DATABASE;
const isolated = typeof database === "string" && /^coasther_broiler_test_[a-z0-9_]+$/.test(database);
if (isolated) process.env.NODE_ENV = "test";

test("Phase5 monitoring HTTP persistence/source/RBAC/provenance/maintenance on isolated migrated database", { skip: isolated ? false : "Set BROILER_TEST_DATABASE to an explicitly isolated coasther_broiler_test_* database", timeout: 60000 }, async () => {
  process.env.JWT_SECRET ||= crypto.randomBytes(32).toString("hex");
  const jwt = require("jsonwebtoken");
  const db = require("../src/config/db");
  const [[actual]] = await db.query("SELECT DATABASE() AS name");
  assert.equal(actual.name, database, "Refusing to run against a database other than the isolated target");
  assert.notEqual(actual.name, "coasther_broiler");
  const app = require("../src/app");
  const ingest = require("../src/services/iotBroiler.service");
  const marker = `p5-monitor-${crypto.randomUUID()}`;
  const users = [];
  let farmId, coopId, deviceId, server;
  const user = async (role) => {
    const [row] = await db.query("INSERT INTO users(name,email,password_hash,role,is_verified) VALUES (?,?,?,?,1)", [marker, `${marker}-${users.length}@example.invalid`, "!unusable-test-password", role]);
    users.push(row.insertId);
    return { id: row.insertId, token: jwt.sign({ id: row.insertId, role }, process.env.JWT_SECRET, { expiresIn: "10m" }) };
  };
  try {
    const owner = await user("admin");
    const reviewer = await user("admin");
    const outsider = await user("operator");
    const [farm] = await db.query("INSERT INTO farms(owner_user_id,name) VALUES (?,?)", [owner.id, marker]); farmId = farm.insertId;
    await db.query("INSERT INTO farm_members(farm_id,user_id,role) VALUES (?,?,'owner')", [farmId, owner.id]);
    const [coop] = await db.query("INSERT INTO coops(farm_id,code,name) VALUES (?,?,?)", [farmId, marker.slice(-30), marker]); coopId = coop.insertId;
    const key = marker.replaceAll("-", "_");
    const [device] = await db.query("INSERT INTO devices(coop_id,device_uid,mqtt_topic_key,name,firmware_version) VALUES (?,?,?,?,?)", [coopId, key, key, marker, "3.1"]); deviceId = device.insertId;
    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${server.address().port}/api/coops/${coopId}`;
    const request = async (who, route, method = "GET", body) => {
      const response = await fetch(base + route, { method, headers: { ...(who ? { Authorization: `Bearer ${who.token}` } : {}), "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, data: await response.json() };
    };
    assert.equal((await request(null, "/telemetry-history")).status, 401);
    assert.equal((await request(outsider, "/telemetry-history")).status, 403);
    assert.equal((await request(owner, "/telemetry-history?minutes=9999")).status, 400);

    const now = new Date(Math.floor(Date.now() / 1000) * 1000);
    for (const seconds of [20, 10]) {
      const outcome = await ingest.handleMessage(`coasther/telemetry/${key}/live`, JSON.stringify({ power: 70, flow_rate_lpm: seconds === 20 ? 0 : 1, recorded_at: new Date(now.getTime() - seconds * 1000).toISOString() }), { source: "simulation", heartbeat: false, receivedAt: now });
      assert.equal(outcome.outcome, "stored");
    }
    const simulation = await request(owner, "/telemetry-history?source=simulation&bucket_seconds=5");
    assert.equal(simulation.status, 200);
    assert.equal(simulation.data.data.samples.length, 2);
    assert.equal(simulation.data.data.samples[0].flow_rate_lpm, 0);
    assert.equal((await request(owner, "/telemetry-history?source=real")).data.data.samples.length, 0);
    const [[physical]] = await db.query("SELECT last_seen_at FROM devices WHERE id=?", [deviceId]);
    assert.equal(physical.last_seen_at, null);
    const diagnostics = await request(owner, "/diagnostics?source=simulation");
    assert.equal(diagnostics.data.data.capabilities.maintenance, false);
    assert.ok(diagnostics.data.data.entries.length > 0);

    const input = { device_id: deviceId, type: "water", reference_value: 10, sensor_value: 10.2, unit: "L", instrument_id: "bucket-fixture-10L", method: "Isolated synthetic fixture comparison", measured_at: now.toISOString(), source: "real" };
    assert.equal((await request(owner, "/calibrations", "POST", { ...input, recorded_by: reviewer.id })).status, 400);
    const created = await request(owner, "/calibrations", "POST", input);
    assert.equal(created.status, 201);
    const calibrationId = created.data.data.calibration.id;
    assert.equal(created.data.data.calibration.verification_state, "manual_recorded");
    const verification = { verification_state: "independently_verified", evidence_note: "Independent synthetic test review" };
    assert.equal((await request(owner, `/calibrations/${calibrationId}`, "PATCH", verification)).status, 409);
    assert.equal((await request(reviewer, `/calibrations/${calibrationId}`, "PATCH", verification)).status, 200);
    const report = await request(owner, "/validation-report");
    assert.equal(report.data.data.calibrations[0].physical_accuracy_confirmed, false);
    assert.equal(report.data.data.telemetry_reliability.state, "insufficient_evidence");

    const maintenance = { device_id: deviceId, command: "reboot", request_id: crypto.randomUUID(), confirmation: "MAINTENANCE ACCEPTED", reason: "Synthetic blocked maintenance acceptance" };
    const blocked = await request(owner, "/maintenance", "POST", maintenance);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.data.data.actions_executed, false);
    assert.equal((await request(owner, "/maintenance", "POST", maintenance)).data.data.request.id, blocked.data.data.request.id);
    assert.equal((await request(owner, "/maintenance", "POST", { ...maintenance, command: "reset_nvs" })).status, 409);
    const [[count]] = await db.query("SELECT COUNT(*) AS n FROM maintenance_requests WHERE coop_id=?", [coopId]);
    assert.equal(Number(count.n), 1);
  } finally {
    if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    if (coopId) {
      for (const table of ["maintenance_requests", "sensor_calibrations", "field_validation_events", "device_diagnostic_entries", "telemetry_samples"]) {
        const [rows] = await db.query(`SELECT id FROM ${table} WHERE coop_id=?`, [coopId]);
        for (const row of rows) await db.query(`DELETE FROM ${table} WHERE id=? AND coop_id=?`, [row.id, coopId]);
      }
      await db.query("DELETE FROM coop_live_status WHERE coop_id=?", [coopId]);
      if (deviceId) await db.query("DELETE FROM devices WHERE id=? AND coop_id=?", [deviceId, coopId]);
      await db.query("DELETE FROM coops WHERE id=? AND farm_id=?", [coopId, farmId]);
    }
    if (farmId) {
      const [members] = await db.query("SELECT id FROM farm_members WHERE farm_id=?", [farmId]);
      for (const row of members) await db.query("DELETE FROM farm_members WHERE id=? AND farm_id=?", [row.id, farmId]);
      await db.query("DELETE FROM farms WHERE id=? AND name=?", [farmId, marker]);
    }
    for (const id of users) await db.query("DELETE FROM users WHERE id=? AND name=?", [id, marker]);
    await db.end();
  }
});
