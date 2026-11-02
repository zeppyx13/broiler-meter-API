const db = require("../config/db");

async function findActiveLeaseByUserId(user_id) {
  const [rows] = await db.query(
    `
    SELECT
      l.id AS lease_id,
      l.user_id,
      l.room_id,
      l.start_date,
      l.end_date,
      l.status,
      l.monthly_rent_snapshot,
      l.note,
      l.created_at
    FROM leases l
    WHERE l.user_id = ? AND l.status = 'active'
    ORDER BY l.start_date DESC
    LIMIT 1
    `,
    [user_id],
  );

  return rows[0] || null;
}

async function findRoomById(room_id) {
  const [rows] = await db.query(
    `
    SELECT
      r.id,
      r.number,
      r.floor,
      r.price_monthly,
      r.deposit,
      r.is_available,
      r.description,
      r.main_image_url,
      r.created_at,
      r.updated_at,
      EXISTS (
        SELECT 1 FROM leases l
        WHERE l.room_id = r.id AND l.status = 'active'
      ) AS is_occupied
    FROM rooms r
    WHERE r.id = ?
    LIMIT 1
    `,
    [room_id],
  );

  return rows[0] || null;
}

async function findFacilitiesByRoomId(room_id) {
  const [rows] = await db.query(
    `
    SELECT f.id, f.name
    FROM room_facilities rf
    JOIN facilities f ON f.id = rf.facility_id
    WHERE rf.room_id = ?
    ORDER BY f.name ASC
    `,
    [room_id],
  );
  return rows;
}

async function findMetersByRoomId(room_id) {
  const [rows] = await db.query(
    `
    SELECT
      id,
      room_id,
      type,
      device_uid,
      unit,
      is_active,
      installed_at,
      created_at,
      updated_at
    FROM meters
    WHERE room_id = ?
    ORDER BY type ASC
    `,
    [room_id],
  );
  return rows;
}

module.exports = {
  findActiveLeaseByUserId,
  findRoomById,
  findFacilitiesByRoomId,
  findMetersByRoomId,
};
