require("dotenv").config({ quiet: true });
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const db = require("../src/config/db");
const { seed } = require("../src/services/phase4Demo.service");
const model = require("../src/models/phase4Demo.model");
if (
  process.env.NODE_ENV === "production" ||
  process.env.DB_NAME !== "coasther_broiler"
)
  throw new Error("Development Broiler DB required");
test("optional Phase 4 simulation seed is repeatable and all fixture writes are rolled back", async (t) => {
  const input = {
    email: `phase4-seed-test-${crypto.randomUUID()}@example.invalid`,
    password: crypto.randomBytes(24).toString("hex"),
  };
  const connection = await db.getConnection();
  const now = new Date("2026-11-05T03:00:00Z");
  let first;
  try {
    await connection.beginTransaction();
    await t.test(
      "creates only a dedicated four-day simulation cohort without physical cursors or heartbeat",
      async () => {
        first = await seed(connection, input, { now });
        assert.equal(first.created, true);
        assert.equal(first.raw_simulation_rows, 10);
        assert.equal(first.closed_observation_days, 4);
        assert.equal(first.source, "simulation");
        assert.equal(first.physical_cursor_updated, false);
        assert.equal(first.heartbeat_updated, false);
        const rows = await model.tree(first.farm_id, connection);
        assert.equal(
          rows.readings.every((row) => row.source === "simulation"),
          true,
        );
        assert.equal(rows.devices[0].last_seen_at, null);
        assert.equal(
          rows.meters.every(
            (row) =>
              row.last_reading_value == null && row.last_reading_at == null,
          ),
          true,
        );
        assert.equal(rows.cycles[0].placement_date, "2026-10-31");
        assert.equal(rows.cycles[0].planned_harvest_date, "2026-12-04");
        const water = rows.readings.filter(
          (row) =>
            rows.meters.find((m) => m.id === row.meter_id).type === "water" &&
            row.reading_status === "accepted",
        );
        assert.deepEqual(
          water.map((row) => Number(row.delta_value)),
          [100, 110, 120, 130],
        );
      },
    );
    await t.test(
      "repeating with matching credentials reuses exact cohort and never adds duplicate readings",
      async () => {
        const second = await seed(connection, input, { now });
        assert.equal(second.reused, true);
        assert.equal(second.coop_id, first.coop_id);
        assert.equal(second.flock_cycle_id, first.flock_cycle_id);
        assert.equal(
          (await model.tree(first.farm_id, connection)).readings.length,
          10,
        );
      },
    );
    await t.test(
      "changed credentials and calendar windows are refused without resetting existing dates",
      async () => {
        await assert.rejects(
          seed(
            connection,
            { ...input, password: crypto.randomBytes(24).toString("hex") },
            { now },
          ),
          /refusing/,
        );
        await assert.rejects(
          seed(connection, input, { now: new Date(now.getTime() + 86400000) }),
          /refusing/,
        );
        const rows = await model.tree(first.farm_id, connection);
        assert.equal(rows.cycles[0].placement_date, "2026-10-31");
        assert.equal(rows.readings.length, 10);
      },
    );
  } finally {
    await connection.rollback();
    connection.release();
    await db.end();
  }
});
