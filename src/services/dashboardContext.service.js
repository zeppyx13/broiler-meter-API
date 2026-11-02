const access = require("./access.service");
const flock = require("./flockCycle.service");

async function get(user) {
  const coop = await access.resolveDefaultCoop(user);
  if (!coop) return { state: "no_coop", coop: null, active_cycle: null };
  const cycle = await flock.active(user, coop.id);
  return { state: cycle ? "ready" : "no_active_cycle", coop, active_cycle: cycle };
}

module.exports = { get };
