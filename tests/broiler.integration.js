require("dotenv").config({ quiet: true });
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

if (
  process.env.NODE_ENV === "production" ||
  process.env.DB_NAME !== "coasther_broiler"
) {
  throw new Error(
    "Integration tests require the imported development coasther_broiler database",
  );
}
process.env.NODE_ENV = "test";
process.env.JWT_SECRET ||= crypto.randomBytes(32).toString("hex");
const db = require("../src/config/db");
const app = require("../src/app");
const userModel = require("../src/models/user.model");
const farmModel = require("../src/models/farm.model");
const flockModel = require("../src/models/flockCycle.model");
const { verify } = require("../src/services/schemaCompatibility.service");
const { localDate } = require("../src/utils/farmDate");

test(
  "broiler core endpoints against imported development schema",
  { timeout: 90000 },
  async (t) => {
    const marker = `core-test-${crypto.randomUUID()}`;
    const password = crypto.randomBytes(24).toString("base64url");
    const emails = [];
    let base;
    let server;
    let admin, manager, operator, outsider, viewer;
    let farm, coop, secondCoop, cycle;
    const today = localDate("Asia/Makassar");
    const yesterday = new Date(Date.parse(today) - 86400000)
      .toISOString()
      .slice(0, 10);

    async function request(method, path, token, payload, expected = 200) {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(payload ? { "Content-Type": "application/json" } : {}),
        },
        ...(payload ? { body: JSON.stringify(payload) } : {}),
      });
      const body = await response.json();
      if (expected !== null)
        assert.equal(
          response.status,
          expected,
          `${method} ${path}: ${JSON.stringify(body)}`,
        );
      return { status: response.status, ...body };
    }

    async function register(label) {
      const email = `${marker}-${label}@example.invalid`;
      emails.push(email);
      const response = await request(
        "POST",
        "/api/auth/register",
        null,
        { name: label, email, password },
        201,
      );
      assert.equal(response.data.user.role, "operator");
      assert.equal("password_hash" in response.data.user, false);
      return { ...response.data, email };
    }

    async function cleanup() {
      // Delete only this run's synthetic fixtures. Never touch sensor or pre-existing business rows.
      const connection = await db.getConnection();
      try {
        await connection.beginTransaction();
        const [users] = emails.length
          ? await connection.query("SELECT id FROM users WHERE email IN (?)", [
              emails,
            ])
          : [[]];
        const ids = users.map((row) => row.id);
        if (ids.length) {
          const [farms] = await connection.query(
            "SELECT id FROM farms WHERE owner_user_id IN (?) AND name LIKE ?",
            [ids, `${marker}%`],
          );
          const farmIds = farms.map((row) => row.id);
          await connection.query(
            "UPDATE users SET default_coop_id = NULL WHERE id IN (?)",
            [ids],
          );
          if (farmIds.length) {
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
      const result = await verify();
      assert.equal(result.verified_tables, 21);
      server = app.listen(0, "127.0.0.1");
      await new Promise((resolve) => server.once("listening", resolve));
      base = `http://127.0.0.1:${server.address().port}`;
      const adminEmail = `${marker}-admin@example.invalid`;
      emails.push(adminEmail);
      await userModel.createUser({
        name: "Core Test Admin",
        email: adminEmail,
        role: "admin",
        password_hash: await bcrypt.hash(password, 10),
      });
      admin = (
        await request("POST", "/api/auth/login", null, {
          email: adminEmail,
          password,
        })
      ).data;
      manager = await register("Manager");
      operator = await register("Operator");
      outsider = await register("Outsider");
      viewer = await register("Viewer");

      await t.test(
        "login, public registration, roles and private user lists",
        async () => {
          await request(
            "POST",
            "/api/auth/login",
            null,
            { email: adminEmail, password: "wrong-password" },
            401,
          );
          await request(
            "POST",
            "/api/auth/login",
            null,
            { email: adminEmail, password: "" },
            400,
          );
          await request(
            "POST",
            "/api/auth/register",
            null,
            {
              name: "Escalation",
              email: `${marker}-bad@example.invalid`,
              password,
              role: "admin",
            },
            400,
          );
          for (const path of [
            "/api/users/all",
            "/api/users/admin",
            "/api/users-admin",
          ]) {
            await request("GET", path, null, null, 401);
            await request("GET", path, operator.token, null, 403);
            await request("GET", path, admin.token);
          }
          await request(
            "PATCH",
            `/api/users-admin/${manager.user.id}`,
            admin.token,
            { role: "manager" },
          );
          await request(
            "PATCH",
            `/api/users-admin/${outsider.user.id}`,
            admin.token,
            { role: "manager" },
          );
          manager = {
            ...manager,
            ...(
              await request("POST", "/api/auth/login", null, {
                email: manager.email,
                password,
              })
            ).data,
          };
          const operatorLogin = await request("POST", "/api/auth/login", null, {
            email: operator.email,
            password,
          });
          assert.equal(operatorLogin.data.user.role, "operator");
          await request(
            "PATCH",
            `/api/users-admin/${operator.user.id}`,
            manager.token,
            { role: "admin" },
            403,
          );
          const fakeOldRole = jwt.sign(
            { id: operator.user.id, role: "admin" },
            process.env.JWT_SECRET,
          );
          await request("GET", "/api/users/all", fakeOldRole, null, 403);
          const me = await request("GET", "/api/auth/me", operator.token);
          for (const key of [
            "password_hash",
            "reset_otp_hash",
            "delete_otp_hash",
            "fcm_token",
          ])
            assert.equal(key in me.data.user, false);
          await request("POST", "/api/auth/forgot-password/otp", null, {
            email: `${marker}-missing@example.invalid`,
          });
          assert.equal(
            (await request("GET", "/api/dashboard/context", operator.token))
              .data.state,
            "no_coop",
          );
        },
      );

      await t.test(
        "farm creation atomically records owner and denies cross-farm access",
        async () => {
          await request(
            "POST",
            "/api/farms",
            operator.token,
            { name: marker },
            403,
          );
          farm = (
            await request(
              "POST",
              "/api/farms",
              manager.token,
              { name: marker, timezone: "Asia/Makassar" },
              201,
            )
          ).data.farm;
          const members = (
            await request("GET", `/api/farms/${farm.id}/members`, manager.token)
          ).data.members;
          assert.equal(
            members.find((member) => member.user_id === manager.user.id).role,
            "owner",
          );
          await request(
            "GET",
            `/api/farms/${farm.id}`,
            outsider.token,
            null,
            403,
          );
          await request(
            "PATCH",
            `/api/farms/${farm.id}`,
            outsider.token,
            { name: `${marker}-hijacked` },
            403,
          );
          await request("PATCH", `/api/farms/${farm.id}`, manager.token, {
            location_text: "Test farm",
          });
          await request(
            "PATCH",
            `/api/farms/${farm.id}`,
            manager.token,
            { timezone: "Invalid/Farm" },
            400,
          );
          const list = await request("GET", "/api/farms", outsider.token);
          assert.equal(
            list.data.farms.some((item) => item.id === farm.id),
            false,
          );
        },
      );

      await t.test(
        "owner membership failure rolls back farm insertion",
        async (subtest) => {
          subtest.mock.method(farmModel, "addMember", async () => {
            throw new Error("Injected membership failure");
          });
          await request(
            "POST",
            "/api/farms",
            manager.token,
            { name: `${marker}-rollback` },
            500,
          );
          const [[row]] = await db.query(
            "SELECT COUNT(*) AS count FROM farms WHERE name = ?",
            [`${marker}-rollback`],
          );
          assert.equal(row.count, 0);
        },
      );

      await t.test(
        "membership management preserves ownership and scoped permissions",
        async () => {
          await request(
            "POST",
            `/api/farms/${farm.id}/members`,
            manager.token,
            { user_id: operator.user.id, role: "operator" },
            201,
          );
          await request(
            "POST",
            `/api/farms/${farm.id}/members`,
            manager.token,
            { user_id: viewer.user.id, role: "viewer" },
            201,
          );
          await request(
            "PATCH",
            `/api/farms/${farm.id}/members/${manager.user.id}`,
            manager.token,
            { role: "operator" },
            409,
          );
          await request(
            "POST",
            `/api/farms/${farm.id}/members`,
            operator.token,
            { user_id: outsider.user.id },
            403,
          );
          await request(
            "POST",
            `/api/farms/${farm.id}/members`,
            manager.token,
            { user_id: operator.user.id },
            409,
          );
        },
      );

      await t.test(
        "coop CRUD, access, and automatic default dashboard context",
        async () => {
          await request(
            "POST",
            "/api/coops",
            operator.token,
            { farm_id: farm.id, code: "BAD", name: "Forbidden" },
            403,
          );
          coop = (
            await request(
              "POST",
              "/api/coops",
              manager.token,
              {
                farm_id: farm.id,
                code: "C1",
                name: "Test Coop",
                capacity_birds: 100,
              },
              201,
            )
          ).data.coop;
          secondCoop = (
            await request(
              "POST",
              "/api/coops",
              manager.token,
              {
                farm_id: farm.id,
                code: "C2",
                name: "Second Coop",
                capacity_birds: 100,
              },
              201,
            )
          ).data.coop;
          assert.equal(
            (await request("GET", "/api/auth/me", manager.token)).data.user
              .default_coop_id,
            coop.id,
          );
          assert.equal(
            (await request("GET", "/api/dashboard/context", operator.token))
              .data.coop.id,
            coop.id,
          );
          assert.equal(
            (await request("GET", "/api/dashboard/context", operator.token))
              .data.state,
            "no_active_cycle",
          );
          await request(
            "GET",
            `/api/coops/${coop.id}`,
            outsider.token,
            null,
            403,
          );
          await request(
            "GET",
            `/api/coops?farm_id=${farm.id}`,
            outsider.token,
            null,
            403,
          );
          await request(
            "PUT",
            "/api/users/me",
            outsider.token,
            { default_coop_id: coop.id },
            403,
          );
          await request("PUT", "/api/users/me", operator.token, {
            default_coop_id: secondCoop.id,
          });
          assert.equal(
            (await request("GET", "/api/dashboard/context", operator.token))
              .data.coop.id,
            secondCoop.id,
          );
          await request("PUT", "/api/users/me", operator.token, {
            default_coop_id: coop.id,
            fcm_token: "synthetic-test-token",
          });
          await request("PUT", `/api/coops/${coop.id}`, manager.token, {
            description: "Updated test coop",
          });
          await request(
            "PATCH",
            `/api/coops/${coop.id}`,
            manager.token,
            { farm_id: farm.id + 1 },
            400,
          );
          await request("GET", "/api/coops/invalid", manager.token, null, 400);
        },
      );

      await t.test(
        "profile default assignment cannot restore access after concurrent membership revocation",
        async (subtest) => {
          const accessModel = require("../src/models/access.model");
          const originalLockFarm = accessModel.lockFarm;
          let entered;
          let resume;
          const reached = new Promise((resolve) => {
            entered = resolve;
          });
          const gate = new Promise((resolve) => {
            resume = resolve;
          });
          subtest.mock.method(accessModel, "lockFarm", async (...args) => {
            entered();
            await gate;
            return originalLockFarm(...args);
          });
          const pending = request(
            "PUT",
            "/api/users/me",
            operator.token,
            { default_coop_id: secondCoop.id },
            403,
          );
          await reached;
          // Keep the revocation on a separate connection while the profile transaction waits.
          const revoke = await db.getConnection();
          try {
            await revoke.beginTransaction();
            await revoke.query("SELECT id FROM farms WHERE id = ? FOR UPDATE", [
              farm.id,
            ]);
            await revoke.query(
              "DELETE FROM farm_members WHERE farm_id = ? AND user_id = ?",
              [farm.id, operator.user.id],
            );
            await revoke.query(
              "UPDATE users SET default_coop_id = NULL WHERE id = ?",
              [operator.user.id],
            );
            await revoke.commit();
          } finally {
            revoke.release();
            resume();
          }
          await pending;
          assert.equal(
            (await userModel.findById(operator.user.id)).default_coop_id,
            null,
          );
          await db.query(
            "INSERT INTO farm_members (farm_id, user_id, role) VALUES (?, ?, 'operator')",
            [farm.id, operator.user.id],
          );
        },
      );

      await t.test(
        "concurrent cycle creation admits one active cycle and uses Day 1",
        async () => {
          const payload = {
            coop_id: coop.id,
            placement_date: today,
            initial_population: 100,
          };
          const responses = await Promise.all([
            request(
              "POST",
              "/api/flock-cycles",
              manager.token,
              { ...payload, cycle_code: "RACE-A" },
              null,
            ),
            request(
              "POST",
              "/api/flock-cycles",
              manager.token,
              { ...payload, cycle_code: "RACE-B" },
              null,
            ),
          ]);
          assert.deepEqual(
            responses.map((response) => response.status).sort(),
            [201, 409],
          );
          cycle = responses.find((response) => response.status === 201).data;
          assert.equal(cycle.day_age, 1);
          const [[row]] = await db.query(
            "SELECT COUNT(*) AS count FROM flock_cycles WHERE coop_id = ? AND status = 'active'",
            [coop.id],
          );
          assert.equal(row.count, 1);
          await request(
            "POST",
            "/api/flock-cycles",
            viewer.token,
            { ...payload, coop_id: secondCoop.id, cycle_code: "VIEWER" },
            403,
          );
          await request(
            "POST",
            "/api/flock-cycles",
            outsider.token,
            { ...payload, cycle_code: "OUTSIDER" },
            403,
          );
          await request(
            "POST",
            "/api/flock-cycles",
            manager.token,
            {
              ...payload,
              coop_id: secondCoop.id,
              cycle_code: "CAPACITY",
              initial_population: 101,
            },
            409,
          );
          const tomorrow = new Date(Date.parse(today) + 86400000)
            .toISOString()
            .slice(0, 10);
          await request(
            "POST",
            "/api/flock-cycles",
            manager.token,
            {
              ...payload,
              coop_id: secondCoop.id,
              cycle_code: "FUTURE",
              placement_date: tomorrow,
            },
            400,
          );
          assert.equal(
            (
              await request(
                "GET",
                `/api/flock-cycles/active?coop_id=${coop.id}`,
                operator.token,
              )
            ).data.cycle.id,
            cycle.id,
          );
          assert.equal(
            (await request("GET", "/api/dashboard/context", operator.token))
              .data.state,
            "ready",
          );
          await request(
            "DELETE",
            `/api/coops/${coop.id}`,
            manager.token,
            null,
            409,
          );
          await request(
            "DELETE",
            `/api/farms/${farm.id}`,
            manager.token,
            null,
            409,
          );
          await request(
            "PATCH",
            `/api/coops/${coop.id}`,
            manager.token,
            { capacity_birds: 99 },
            409,
          );
        },
      );

      await t.test(
        "population events handle mortality, culling, adjustment and harvest atomically",
        async () => {
          await request(
            "POST",
            `/api/flock-cycles/${cycle.id}/events`,
            viewer.token,
            { event_type: "mortality", population_change: -1 },
            403,
          );
          await request(
            "POST",
            `/api/flock-cycles/${cycle.id}/events`,
            operator.token,
            { event_type: "mortality", population_change: 1 },
            400,
          );
          await request(
            "POST",
            `/api/flock-cycles/${cycle.id}/events`,
            operator.token,
            { event_type: "adjustment", population_change: 1 },
            400,
          );
          await request(
            "POST",
            `/api/flock-cycles/${cycle.id}/events`,
            operator.token,
            {
              event_type: "mortality",
              population_change: -1,
              event_date: yesterday,
            },
            400,
          );
          const basePath = `/api/flock-cycles/${cycle.id}/events`;
          await request(
            "POST",
            basePath,
            operator.token,
            { event_type: "mortality", population_change: -3 },
            201,
          );
          await request(
            "POST",
            basePath,
            operator.token,
            { event_type: "culling", population_change: -2 },
            201,
          );
          await request(
            "POST",
            basePath,
            operator.token,
            {
              event_type: "adjustment",
              population_change: 2,
              notes: "Correction after recount",
            },
            201,
          );
          await request(
            "POST",
            basePath,
            operator.token,
            { event_type: "harvest", population_change: -7 },
            201,
          );
          await request(
            "POST",
            basePath,
            operator.token,
            { event_type: "mortality", population_change: -91 },
            409,
          );
          const result = await request(
            "GET",
            `/api/flock-cycles/${cycle.id}`,
            operator.token,
          );
          assert.equal(result.data.cycle.current_population, 90);
          const events = (await request("GET", basePath, viewer.token)).data
            .events;
          assert.equal(events.length, 4);
          assert.equal(
            100 +
              events.reduce((sum, event) => sum + event.population_change, 0),
            90,
          );
          assert.equal(
            events.every((event) => event.recorded_by === operator.user.id),
            true,
          );
        },
      );

      await t.test(
        "population database failure rolls back the inserted event",
        async (subtest) => {
          subtest.mock.method(flockModel, "updatePopulation", async () => {
            throw new Error("Injected population failure");
          });
          await request(
            "POST",
            `/api/flock-cycles/${cycle.id}/events`,
            operator.token,
            { event_type: "mortality", population_change: -1 },
            500,
          );
          const events = (
            await request(
              "GET",
              `/api/flock-cycles/${cycle.id}/events`,
              operator.token,
            )
          ).data.events;
          assert.equal(events.length, 4);
          assert.equal(
            (
              await request(
                "GET",
                `/api/flock-cycles/${cycle.id}`,
                operator.token,
              )
            ).data.cycle.current_population,
            90,
          );
        },
      );

      await t.test(
        "concurrent population reductions cannot overdraw the flock",
        async () => {
          const responses = await Promise.all([
            request(
              "POST",
              `/api/flock-cycles/${cycle.id}/events`,
              operator.token,
              { event_type: "mortality", population_change: -60 },
              null,
            ),
            request(
              "POST",
              `/api/flock-cycles/${cycle.id}/events`,
              operator.token,
              { event_type: "culling", population_change: -60 },
              null,
            ),
          ]);
          assert.deepEqual(
            responses.map((response) => response.status).sort(),
            [201, 409],
          );
          assert.equal(
            (
              await request(
                "GET",
                `/api/flock-cycles/${cycle.id}`,
                manager.token,
              )
            ).data.cycle.current_population,
            30,
          );
        },
      );

      await t.test(
        "completion preserves history and unlocks the next production cycle",
        async () => {
          await request(
            "POST",
            `/api/flock-cycles/${cycle.id}/events`,
            operator.token,
            { event_type: "harvest", population_change: -30 },
            201,
          );
          const completed = await request(
            "PATCH",
            `/api/flock-cycles/${cycle.id}/complete`,
            manager.token,
            {},
          );
          assert.equal(completed.data.cycle.status, "completed");
          assert.equal(completed.data.cycle.current_population, 0);
          await request(
            "POST",
            `/api/flock-cycles/${cycle.id}/events`,
            operator.token,
            { event_type: "mortality", population_change: -1 },
            409,
          );
          const history = await request(
            "GET",
            `/api/flock-cycles?coop_id=${coop.id}&status=completed`,
            viewer.token,
          );
          assert.equal(history.data.cycles[0].id, cycle.id);
          assert.equal(
            (
              await request(
                "GET",
                `/api/flock-cycles/active?coop_id=${coop.id}`,
                operator.token,
              )
            ).data.cycle,
            null,
          );
          const next = await request(
            "POST",
            "/api/flock-cycles",
            manager.token,
            {
              coop_id: coop.id,
              cycle_code: "NEXT",
              placement_date: today,
              initial_population: 100,
            },
            201,
          );
          await request(
            "PATCH",
            `/api/flock-cycles/${next.data.id}/complete`,
            manager.token,
            {},
          );
          assert.equal(
            (
              await request(
                "GET",
                `/api/flock-cycles/${next.data.id}`,
                viewer.token,
              )
            ).data.cycle.current_population,
            100,
          );
        },
      );

      await t.test(
        "completion sees events committed while it waits for the parent lock",
        async (subtest) => {
          const older = (
            await request(
              "POST",
              "/api/flock-cycles",
              manager.token,
              {
                coop_id: secondCoop.id,
                cycle_code: "COMPLETION-RACE",
                placement_date: yesterday,
                initial_population: 10,
              },
              201,
            )
          ).data;
          const accessModel = require("../src/models/access.model");
          const findCoop = accessModel.findCoop;
          let entered;
          let resume;
          const reached = new Promise((resolve) => {
            entered = resolve;
          });
          const gate = new Promise((resolve) => {
            resume = resolve;
          });
          subtest.mock.method(accessModel, "findCoop", async (...args) => {
            const result = await findCoop(...args);
            entered();
            await gate;
            return result;
          });
          const pending = request(
            "PATCH",
            `/api/flock-cycles/${older.id}/complete`,
            manager.token,
            { actual_harvest_date: yesterday },
            400,
          );
          await reached;
          const eventConnection = await db.getConnection();
          try {
            await eventConnection.beginTransaction();
            await eventConnection.query(
              "SELECT id FROM farms WHERE id = ? FOR UPDATE",
              [farm.id],
            );
            await eventConnection.query(
              "SELECT id FROM coops WHERE id = ? FOR UPDATE",
              [secondCoop.id],
            );
            await eventConnection.query(
              "SELECT id FROM flock_cycles WHERE id = ? FOR UPDATE",
              [older.id],
            );
            await flockModel.insertEvent(
              older.id,
              {
                event_type: "mortality",
                population_change: -1,
                event_date: today,
              },
              operator.user.id,
              eventConnection,
            );
            await flockModel.updatePopulation(older.id, 9, eventConnection);
            await eventConnection.commit();
          } finally {
            eventConnection.release();
            resume();
          }
          await pending;
          subtest.mock.restoreAll();
          await request(
            "PATCH",
            `/api/flock-cycles/${older.id}/complete`,
            manager.token,
            { actual_harvest_date: today },
          );
        },
      );

      await t.test(
        "membership revocation invalidates default context without requiring a coop picker",
        async () => {
          await request(
            "DELETE",
            `/api/farms/${farm.id}/members/${operator.user.id}`,
            manager.token,
          );
          const context = (
            await request("GET", "/api/dashboard/context", operator.token)
          ).data;
          assert.equal(context.state, "no_coop");
          assert.equal(context.coop, null);
          assert.equal(
            (await request("GET", "/api/auth/me", operator.token)).data.user
              .default_coop_id,
            null,
          );
          await request(
            "GET",
            `/api/coops/${coop.id}`,
            operator.token,
            null,
            403,
          );
          await request(
            "GET",
            `/api/flock-cycles/${cycle.id}/events`,
            operator.token,
            null,
            403,
          );
          await request(
            "DELETE",
            `/api/users-admin/${manager.user.id}`,
            admin.token,
            null,
            409,
          );
        },
      );

      await t.test(
        "archiving coops and farms preserves cycle/event history and repairs defaults",
        async () => {
          await request("DELETE", `/api/coops/${coop.id}`, manager.token);
          assert.equal(
            (await request("GET", "/api/dashboard/context", manager.token)).data
              .coop.id,
            secondCoop.id,
          );
          await request("DELETE", `/api/coops/${secondCoop.id}`, manager.token);
          assert.equal(
            (await request("GET", "/api/dashboard/context", manager.token)).data
              .state,
            "no_coop",
          );
          await request(
            "PUT",
            "/api/users/me",
            manager.token,
            { default_coop_id: coop.id },
            409,
          );
          await request("DELETE", `/api/farms/${farm.id}`, manager.token);
          assert.equal(
            (
              await request(
                "GET",
                `/api/flock-cycles/${cycle.id}/events`,
                viewer.token,
              )
            ).data.events.length,
            6,
          );
          await request("PATCH", `/api/farms/${farm.id}`, manager.token, {
            is_active: true,
          });
          await request("PATCH", `/api/coops/${secondCoop.id}`, manager.token, {
            status: "active",
          });
          await request("DELETE", `/api/farms/${farm.id}`, manager.token);
          await request(
            "POST",
            "/api/flock-cycles",
            manager.token,
            {
              coop_id: secondCoop.id,
              cycle_code: "INACTIVE",
              placement_date: today,
              initial_population: 1,
            },
            409,
          );
        },
      );

      await t.test(
        "demo seed is repeatable and refuses to modify a non-demo account",
        async () => {
          const connection = await db.getConnection();
          const { seed } = require("../src/services/demoSeed.service");
          try {
            await connection.beginTransaction();
            const options = {
              email: `${marker}-seed@example.invalid`,
              password,
            };
            const first = await seed(connection, options);
            const second = await seed(connection, options);
            assert.deepEqual(first, second);
            assert.equal(first.sensor_readings_created, 0);
            await assert.rejects(
              seed(connection, { email: manager.email, password }),
              /refusing to modify or elevate/,
            );
          } finally {
            await connection.rollback();
            connection.release();
          }
        },
      );

      await t.test(
        "broiler runtime does not expose legacy monitoring, relay or billing routes",
        async () => {
          for (const path of [
            "/api/rooms",
            "/api/iot/live-status",
            "/api/scheduler/status",
            "/api/ai",
            "/api/notifications",
          ]) {
            await request("GET", path, admin.token, null, 404);
          }
          await request(
            "POST",
            "/api/iot/relay/1",
            admin.token,
            { command: "relay_on" },
            404,
          );
          assert.equal(
            Object.keys(require.cache).some((key) =>
              /[\\/]config[\\/]mqtt\.js$/.test(key),
            ),
            false,
          );
          assert.equal(
            Object.keys(require.cache).some((key) =>
              /[\\/]jobs[\\/]scheduler\.js$/.test(key),
            ),
            false,
          );
        },
      );

      await t.test(
        "deleting an unreferenced account immediately invalidates its existing JWT",
        async () => {
          await request(
            "DELETE",
            `/api/users-admin/${outsider.user.id}`,
            admin.token,
          );
          await request("GET", "/api/auth/me", outsider.token, null, 401);
        },
      );
    } finally {
      try {
        await cleanup();
      } finally {
        if (server)
          await new Promise((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          );
        await db.end();
      }
    }
  },
);
