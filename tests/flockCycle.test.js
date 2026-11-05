const { test } = require("node:test");
const assert = require("node:assert/strict");
const { localDate, dayAge } = require("../src/utils/farmDate");
const validator = require("../src/validators/flockCycle.validator");
const db = require("../src/config/db");
const access = require("../src/services/access.service");
const model = require("../src/models/flockCycle.model");
const service = require("../src/services/flockCycle.service");

test("broiler age uses farm-local calendar dates, with placement as Day 1", () => {
  const instant = new Date("2026-11-02T16:30:00Z");
  assert.equal(localDate("Asia/Makassar", instant), "2026-11-03");
  assert.equal(localDate("America/Los_Angeles", instant), "2026-11-02");
  assert.equal(dayAge("2026-11-03", "2026-11-03"), 1);
  assert.equal(dayAge("2026-03-07", "2026-03-09"), 3);
  assert.equal(dayAge("2024-02-28", "2024-03-01"), 3);
});

test("flock validation rejects invalid dates, wrong event signs and unexplained adjustments", () => {
  const base = { coop_id: 1, cycle_code: "C1", placement_date: "2026-02-30", initial_population: 100 };
  assert.equal(validator.createSchema.safeParse(base).success, false);
  assert.equal(validator.createSchema.safeParse({ ...base, placement_date: "2026-11-03", planned_harvest_date: "2026-11-02" }).success, false);
  assert.equal(validator.eventSchema.safeParse({ event_type: "mortality", population_change: 1 }).success, false);
  assert.equal(validator.eventSchema.safeParse({ event_type: "adjustment", population_change: 1 }).success, false);
  assert.equal(validator.eventSchema.safeParse({ event_type: "adjustment", population_change: 1, notes: "Count correction" }).success, true);
});

function transactionMock(t) {
  const calls = [];
  const connection = {
    async beginTransaction() { calls.push("begin"); },
    async commit() { calls.push("commit"); },
    async rollback() { calls.push("rollback"); },
    release() { calls.push("release"); },
  };
  t.mock.method(db, "getConnection", async () => connection);
  t.mock.method(access, "lockCoop", async () => calls.push("coop_lock"));
  t.mock.method(access, "requireCoop", async () => ({ id: 1, timezone: "Asia/Makassar", capacity_birds: 100 }));
  return { connection, calls };
}

test("cycle creation rolls back if owner coop already has an active cycle", async (t) => {
  const { calls } = transactionMock(t);
  t.mock.method(model, "activeForUpdate", async () => ({ id: 2 }));
  const insert = t.mock.method(model, "create", async () => assert.fail("Duplicate cycle must not be inserted"));
  await assert.rejects(service.create({ id: 1 }, {
    coop_id: 1, placement_date: "2026-01-01", initial_population: 10,
  }), { statusCode: 409 });
  assert.equal(insert.mock.callCount(), 0);
  assert.deepEqual(calls, ["begin", "coop_lock", "rollback", "release"]);
});

test("event insertion and population update roll back together on database failure", async (t) => {
  const { calls } = transactionMock(t);
  const cycle = { id: 2, coop_id: 1, status: "active", current_population: 100, placement_date: "2026-01-01", timezone: "Asia/Makassar" };
  t.mock.method(model, "findById", async () => cycle);
  t.mock.method(model, "lockById", async () => cycle);
  t.mock.method(model, "insertEvent", async () => { calls.push("event"); return 3; });
  t.mock.method(model, "updatePopulation", async (id, population) => {
    assert.equal(population, 99);
    calls.push("population");
    throw new Error("Injected database failure");
  });
  await assert.rejects(service.recordEvent({ id: 1 }, 2, {
    event_type: "mortality", population_change: -1, event_date: "2026-01-01",
  }), /Injected database failure/);
  assert.deepEqual(calls, ["begin", "coop_lock", "event", "population", "rollback", "release"]);
});

test("population bounds are checked before inserting an event", async (t) => {
  transactionMock(t);
  const cycle = { id: 2, coop_id: 1, status: "active", current_population: 1, placement_date: "2026-01-01", timezone: "Asia/Makassar" };
  t.mock.method(model, "findById", async () => cycle);
  t.mock.method(model, "lockById", async () => cycle);
  const insert = t.mock.method(model, "insertEvent", async () => assert.fail("Invalid population must not be recorded"));
  await assert.rejects(service.recordEvent({ id: 1 }, 2, { event_type: "mortality", population_change: -2 }), { statusCode: 409 });
  await assert.rejects(service.recordEvent({ id: 1 }, 2, { event_type: "adjustment", population_change: 100 }), { statusCode: 409 });
  assert.equal(insert.mock.callCount(), 0);
});

test("omitted placement follows each request across farm-local midnight", async (t) => {
  transactionMock(t);
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-02T15:59:00Z") });
  t.mock.method(model, "activeForUpdate", async () => null);
  let stored;
  t.mock.method(model, "create", async (payload) => {
    stored = { id: 2, ...payload, status: "active", timezone: "Asia/Makassar" };
    return 2;
  });
  t.mock.method(model, "findById", async () => stored);
  const input = { coop_id: 1, cycle_code: "C1", initial_population: 10 };
  const beforeMidnight = await service.create({ id: 1 }, validator.createSchema.parse(input));
  assert.equal(beforeMidnight.placement_date, "2026-11-02");
  assert.equal(beforeMidnight.day_age, 1);
  t.mock.timers.setTime(Date.parse("2026-11-02T16:01:00Z"));
  const afterMidnight = await service.create({ id: 1 }, validator.createSchema.parse(input));
  assert.equal(afterMidnight.placement_date, "2026-11-03");
  assert.equal(afterMidnight.day_age, 1);
  assert.equal(input.placement_date, undefined);
});

test("placement defaults use the authorized farm timezone while explicit dates remain intact", async (t) => {
  transactionMock(t);
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-02T16:30:00Z") });
  t.mock.method(model, "activeForUpdate", async () => null);
  let stored;
  let timezone;
  t.mock.method(access, "requireCoop", async () => ({ id: 1, timezone, capacity_birds: 100 }));
  t.mock.method(model, "create", async (payload) => {
    stored = { id: 2, ...payload, status: "active", timezone };
    return 2;
  });
  t.mock.method(model, "findById", async () => stored);
  for (const [zone, expected] of [["Asia/Makassar", "2026-11-03"], ["America/Los_Angeles", "2026-11-02"]]) {
    timezone = zone;
    const result = await service.create({ id: 1 }, validator.createSchema.parse({
      coop_id: 1, cycle_code: "C1", initial_population: 10, planned_harvest_date: "2026-11-30",
    }));
    assert.equal(result.placement_date, expected);
  }
  const explicit = await service.create({ id: 1 }, validator.createSchema.parse({
    coop_id: 1, cycle_code: "C1", initial_population: 10, placement_date: "2026-11-01",
  }));
  assert.equal(explicit.placement_date, "2026-11-01");
});

test("planned harvest before an omitted farm-local placement is rejected before insertion", async (t) => {
  const { calls } = transactionMock(t);
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-02T16:30:00Z") });
  const insert = t.mock.method(model, "create", async () => assert.fail("Invalid harvest must not be saved"));
  const payload = validator.createSchema.parse({
    coop_id: 1, cycle_code: "C1", initial_population: 10, planned_harvest_date: "2026-11-02",
  });
  await assert.rejects(service.create({ id: 1 }, payload), { statusCode: 400, message: "Planned harvest cannot precede placement" });
  assert.equal(insert.mock.callCount(), 0);
  assert.deepEqual(calls, ["begin", "coop_lock", "rollback", "release"]);
});
