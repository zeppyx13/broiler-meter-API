const { tableAvailable } = require("./phase5Schema");

// Identifiers below are owned SQL expressions, never request values.
async function predicate(connection, coop = "c.id", user = "m.user_id", role = "m.role") {
  if (!(await tableAvailable(connection, "coop_members"))) return "1=1";
  return `(EXISTS (SELECT 1 FROM users scope_global_admin WHERE scope_global_admin.id=${user} AND scope_global_admin.role='admin') OR ${role} <> 'operator' OR EXISTS (SELECT 1 FROM coop_members scope_member WHERE scope_member.coop_id=${coop} AND scope_member.user_id=${user} AND scope_member.revoked_at IS NULL))`;
}

module.exports = { predicate };
