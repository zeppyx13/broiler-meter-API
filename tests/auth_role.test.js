const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const userModel = require("../src/models/user.model");
const db = require("../src/config/db");
const authService = require("../src/services/auth.service");
const userService = require("../src/services/user.service");
const accessService = require("../src/services/access.service");
const auth = require("../src/middlewares/auth.middleware");
const { requireRole } = require("../src/middlewares/role.middleware");
const { registerSchema } = require("../src/validators/auth.validator");
const { updateMeSchema } = require("../src/validators/user.validator");

process.env.JWT_SECRET = crypto.randomBytes(32).toString("hex");

test("registration hashes the password and always creates an operator", async (t) => {
  t.mock.method(userModel, "findByEmail", async () => null);
  t.mock.method(userModel, "createUser", async (payload) => {
    assert.equal(payload.role, "operator");
    assert.notEqual(payload.password_hash, "testing-password");
    assert.equal(await bcrypt.compare("testing-password", payload.password_hash), true);
    return 11;
  });
  t.mock.method(userModel, "findById", async () => ({ id: 11, name: "Operator", role: "operator", email: "operator@example.test", default_coop_id: null }));
  const result = await authService.register({ name: "Operator", email: "operator@example.test", password: "testing-password", role: "admin" });
  assert.equal(result.user.role, "operator");
  assert.equal(jwt.verify(result.token, process.env.JWT_SECRET).role, "operator");
  assert.equal("password_hash" in result.user, false);
});

test("login verifies bcrypt credentials and returns the accessible default", async (t) => {
  const row = { id: 12, role: "manager", email: "manager@example.test", default_coop_id: 5 };
  t.mock.method(userModel, "findByEmail", async () => ({ ...row, password_hash: await bcrypt.hash("testing-password", 4) }));
  t.mock.method(userModel, "findById", async () => ({ ...row }));
  t.mock.method(accessService, "resolveDefaultCoop", async () => ({ id: 7 }));
  await assert.rejects(authService.login({ email: row.email, password: "incorrect" }), { statusCode: 401 });
  const result = await authService.login({ email: row.email, password: "testing-password" });
  assert.equal(result.user.default_coop_id, 7);
  assert.equal(jwt.verify(result.token, process.env.JWT_SECRET).id, 12);
});

test("authentication uses the current database role instead of stale JWT privileges", async (t) => {
  t.mock.method(userModel, "findById", async () => ({ id: 13, role: "operator" }));
  const token = jwt.sign({ id: 13, role: "admin" }, process.env.JWT_SECRET);
  const req = { headers: { authorization: `Bearer ${token}` } };
  let nextError;
  await auth(req, {}, (err) => { nextError = err; });
  assert.equal(nextError, undefined);
  assert.equal(req.user.role, "operator");
  requireRole(["admin"])(req, {}, (err) => { nextError = err; });
  assert.equal(nextError.statusCode, 403);
});

test("authentication rejects tokens for deleted accounts", async (t) => {
  t.mock.method(userModel, "findById", async () => null);
  const token = jwt.sign({ id: 14, role: "admin" }, process.env.JWT_SECRET);
  const res = { status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  await auth({ headers: { authorization: `Bearer ${token}` } }, res, () => assert.fail("Deleted user must not authenticate"));
  assert.equal(res.code, 401);
  assert.equal(res.body.success, false);
});

test("profile updates reject inaccessible default coops before writing", async (t) => {
  const connection = { beginTransaction: async () => {}, rollback: async () => {}, release() {} };
  t.mock.method(db, "getConnection", async () => connection);
  t.mock.method(accessService, "lockCoop", async () => {});
  t.mock.method(userModel, "findById", async () => ({ id: 15, role: "operator" }));
  t.mock.method(accessService, "requireCoop", async () => { throw Object.assign(new Error("Forbidden"), { statusCode: 403 }); });
  const update = t.mock.method(userModel, "updateById", async () => assert.fail("Unauthorized default must not be saved"));
  await assert.rejects(userService.updateMe(15, { default_coop_id: 99 }), { statusCode: 403 });
  assert.equal(update.mock.callCount(), 0);
});

test("default coop validation and profile write share a transaction in farm-coop-user lock order", async (t) => {
  const calls = [];
  const connection = {
    beginTransaction: async () => calls.push("begin"),
    commit: async () => calls.push("commit"),
    rollback: async () => assert.fail("Authorized update must commit"),
    release() { calls.push("release"); },
  };
  t.mock.method(db, "getConnection", async () => connection);
  t.mock.method(accessService, "lockCoop", async (conn) => {
    assert.equal(conn, connection);
    calls.push("farm-coop-lock");
  });
  t.mock.method(userModel, "findById", async (id, conn) => {
    assert.equal(conn, connection);
    return { id, role: "operator", default_coop_id: 7 };
  });
  t.mock.method(accessService, "requireCoop", async (user, id, capability, conn) => {
    assert.equal(conn, connection);
    assert.equal(capability, "read");
    calls.push("validate-access");
    return { id, status: "active", farm_is_active: 1 };
  });
  t.mock.method(userModel, "lockById", async (id, conn) => {
    assert.equal(conn, connection);
    calls.push("user-lock");
    return { id };
  });
  t.mock.method(userModel, "updateById", async (id, payload, conn) => {
    assert.equal(conn, connection);
    calls.push("write");
  });
  const result = await userService.updateMe(15, { default_coop_id: 7 });
  assert.equal(result.user.default_coop_id, 7);
  assert.deepEqual(calls, ["begin", "farm-coop-lock", "validate-access", "user-lock", "write", "commit", "release"]);
});

test("account validators prevent public role escalation and enforce database bounds", () => {
  assert.equal(registerSchema.safeParse({ name: "Demo", email: "demo@example.test", password: "testing-password", role: "admin" }).success, false);
  assert.equal(registerSchema.safeParse({ name: "Demo", email: "demo@example.test", password: "a".repeat(73) }).success, false);
  assert.equal(updateMeSchema.safeParse({ default_coop_id: -1 }).success, false);
  assert.equal(updateMeSchema.safeParse({ role: "admin" }).success, false);
  assert.equal(updateMeSchema.safeParse({ default_coop_id: null, fcm_token: null }).success, true);
});
