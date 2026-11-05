async function account(email, connection) {
  const [[row]] = await connection.query(
    "SELECT id,name,role,password_hash,default_coop_id FROM users WHERE email=?",
    [email],
  );
  return row || null;
}
async function createAccount(email, hash, connection) {
  const [row] = await connection.query(
    "INSERT INTO users(name,email,password_hash,role,is_verified) VALUES (?,?,?,'admin',1)",
    ["COASTHER Phase 4 Simulation Admin", email, hash],
  );
  return row.insertId;
}
async function farm(userId, connection) {
  const [[row]] = await connection.query(
    "SELECT * FROM farms WHERE owner_user_id=? AND name=? ORDER BY id LIMIT 1 FOR UPDATE",
    [userId, "COASTHER Phase 4 SIMULATION Farm"],
  );
  return row || null;
}
async function createFarm(userId, connection) {
  const [row] = await connection.query(
    `INSERT INTO farms(owner_user_id,name,timezone,electricity_rate_idr_per_kwh,water_rate_idr_per_m3)
    VALUES (?,?,'Asia/Makassar',1500,2000)`,
    [userId, "COASTHER Phase 4 SIMULATION Farm"],
  );
  await connection.query(
    "INSERT INTO farm_members(farm_id,user_id,role) VALUES (?,?,'owner')",
    [row.insertId, userId],
  );
  return row.insertId;
}
async function tree(farmId, connection) {
  const [coops] = await connection.query(
    "SELECT * FROM coops WHERE farm_id=? ORDER BY id FOR UPDATE",
    [farmId],
  );
  const coop = coops[0];
  if (!coop) return null;
  const [cycles] = await connection.query(
    `SELECT *,DATE_FORMAT(placement_date,'%Y-%m-%d') AS placement_date,
    DATE_FORMAT(planned_harvest_date,'%Y-%m-%d') AS planned_harvest_date FROM flock_cycles WHERE coop_id=? ORDER BY id`,
    [coop.id],
  );
  const [devices] = await connection.query(
    "SELECT * FROM devices WHERE coop_id=? ORDER BY id",
    [coop.id],
  );
  const [meters] = devices.length
    ? await connection.query(
        "SELECT * FROM meters WHERE device_id IN (?) ORDER BY id",
        [devices.map((row) => row.id)],
      )
    : [[]];
  const [readings] = await connection.query(
    "SELECT meter_id,flock_cycle_id,reading_value,delta_value,reading_status,source,recorded_at FROM meter_readings WHERE coop_id=? ORDER BY recorded_at,meter_id",
    [coop.id],
  );
  const [[member]] = await connection.query(
    "SELECT role FROM farm_members WHERE farm_id=? AND user_id=(SELECT owner_user_id FROM farms WHERE id=?)",
    [farmId, farmId],
  );
  return {
    coop,
    coop_count: coops.length,
    cycles,
    devices,
    meters,
    readings,
    member,
  };
}
async function createTree(farmId, userId, placement, harvest, connection) {
  const key = `phase4_sim_${userId}`;
  const [coop] = await connection.query(
    "INSERT INTO coops(farm_id,code,name,capacity_birds,description) VALUES (?,?,'Phase 4 SIMULATION Coop',2000,?)",
    [
      farmId,
      "PHASE4-SIM",
      "Synthetic multi-day analytics demonstration; never a physical pairing",
    ],
  );
  const [cycle] = await connection.query(
    `INSERT INTO flock_cycles(coop_id,cycle_code,placement_date,planned_harvest_date,initial_population,current_population,status,notes)
    VALUES (?,'PHASE4-SIM',?,?,1000,1000,'active',?)`,
    [
      coop.insertId,
      placement,
      harvest,
      "SIMULATION cohort only; dates are never reset by this seed",
    ],
  );
  const [device] = await connection.query(
    "INSERT INTO devices(coop_id,device_uid,mqtt_topic_key,name,device_type) VALUES (?,?,?,'SIMULATION only - no hardware','other')",
    [coop.insertId, key, key],
  );
  const meters = [];
  for (const [type, unit] of [
    ["water", "liter"],
    ["electricity", "kwh"],
  ]) {
    const [meter] = await connection.query(
      "INSERT INTO meters(device_id,meter_uid,type,channel,unit) VALUES (?,?,?,'main',?)",
      [device.insertId, `${key}_${type}`, type, unit],
    );
    meters.push({ id: meter.insertId, type });
  }
  return {
    coop_id: coop.insertId,
    flock_cycle_id: cycle.insertId,
    device_id: device.insertId,
    meters,
  };
}
async function insertReading(ids, row, connection) {
  await connection.query(
    `INSERT INTO meter_readings(meter_id,coop_id,flock_cycle_id,reading_value,delta_value,reading_status,source,recorded_at)
    VALUES (?,?,?,?,?,?,'simulation',?)`,
    [
      row.meter_id,
      ids.coop_id,
      ids.flock_cycle_id,
      row.reading_value,
      row.delta_value,
      row.reading_status,
      row.recorded_at,
    ],
  );
}
async function setDefault(userId, coopId, connection) {
  await connection.query(
    "UPDATE users SET default_coop_id=? WHERE id=? AND default_coop_id IS NULL",
    [coopId, userId],
  );
}
async function acquire(key, connection) {
  const [[row]] = await connection.query("SELECT GET_LOCK(?,0) AS acquired", [
    key,
  ]);
  return Boolean(row.acquired);
}
async function release(key, connection) {
  await connection.query("SELECT RELEASE_LOCK(?)", [key]);
}
module.exports = {
  account,
  createAccount,
  farm,
  createFarm,
  tree,
  createTree,
  insertReading,
  setDefault,
  acquire,
  release,
};
