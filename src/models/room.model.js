const db = require("../config/db");

async function findAll({ search, is_available, page = 1, limit = 20 }) {
  const p = Math.max(1, Number(page));
  const l = Math.min(100, Math.max(1, Number(limit)));
  const offset = (p - 1) * l;

  const where = [];
  const params = [];

  if (typeof is_available === "boolean") {
    where.push("r.is_available = ?");
    params.push(is_available ? 1 : 0);
  }

  if (search) {
    where.push("(r.number LIKE ?)");
    params.push(`%${search}%`);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

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
    ${whereSql}
    ORDER BY r.number ASC
    LIMIT ? OFFSET ?
    `,
    [...params, l, offset],
  );

  const [countRows] = await db.query(
    `SELECT COUNT(*) AS total FROM rooms r ${whereSql}`,
    params,
  );

  return { rows, total: countRows[0]?.total || 0, page: p, limit: l };
}

async function findById(id) {
  const [rows] = await db.query(
    `
    SELECT
      r.*,
      EXISTS (
        SELECT 1 FROM leases l
        WHERE l.room_id = r.id AND l.status = 'active'
      ) AS is_occupied
    FROM rooms r
    WHERE r.id = ?
    LIMIT 1
    `,
    [id],
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

async function roomstats() {
  const [rows] = await db.query(
    `SELECT
  r.id AS room_id,
  r.number AS room_number,
  r.floor AS room_floor,
  u.name AS tenant_name,
  CASE
    WHEN t.id IS NOT NULL THEN 'Terisi'
    ELSE 'Kosong'
  END AS status,
  COALESCE(i.total_amount, 0) AS bill_amount
FROM rooms r
LEFT JOIN leases t 
  ON t.room_id = r.id 
  AND t.status = 'active'
LEFT JOIN users u 
  ON u.id = t.user_id
LEFT JOIN (
  SELECT 
    room_id,
    SUM(total_amount) AS total_amount
  FROM invoices
  WHERE status = 'unpaid'
  GROUP BY room_id
) i 
  ON i.room_id = r.id
ORDER BY 
  CASE WHEN t.id IS NOT NULL THEN 0 ELSE 1 END,
  COALESCE(i.total_amount, 0) DESC,
  r.floor ASC,
  r.number ASC
LIMIT 5;`,
  );
  return rows;
}

async function createRoom({
  number,
  floor = null,
  price_monthly,
  deposit = 0,
  is_available = true,
  description = null,
  main_image_url = null,
}) {
  const [result] = await db.query(
    `
    INSERT INTO rooms
      (number, floor, price_monthly, deposit, is_available, description, main_image_url)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    [
      number,
      floor,
      price_monthly,
      deposit,
      is_available ? 1 : 0,
      description,
      main_image_url,
    ],
  );
  return result.insertId;
}

async function updateRoomById(id, data) {
  const allowed = [
    "number",
    "floor",
    "price_monthly",
    "deposit",
    "is_available",
    "description",
    "main_image_url",
  ];

  const fields = [];
  const params = [];

  for (const key of allowed) {
    if (data[key] === undefined) continue;

    if (key === "is_available") {
      fields.push(`${key} = ?`);
      params.push(data[key] ? 1 : 0);
      continue;
    }

    fields.push(`${key} = ?`);
    params.push(data[key]);
  }

  if (!fields.length) return;

  params.push(id);

  await db.query(`UPDATE rooms SET ${fields.join(", ")} WHERE id = ?`, params);
}

async function replaceRoomFacilities(room_id, facility_ids) {
  await db.query(`DELETE FROM room_facilities WHERE room_id = ?`, [room_id]);

  if (!facility_ids || facility_ids.length === 0) return;

  const values = facility_ids.map((fid) => [room_id, fid]);
  await db.query(
    `INSERT INTO room_facilities (room_id, facility_id) VALUES ?`,
    [values],
  );
}

async function findRoomsWithFacilitiesAndReviewAgg(params = {}) {
  const page = Number(params.page || 1);
  const limit = Number(params.limit || 20);
  const offset = (page - 1) * limit;

  const search = String(params.search || "").trim();
  const is_available =
    params.is_available === undefined ||
    params.is_available === null ||
    params.is_available === ""
      ? null
      : Number(params.is_available);
  const where = [];
  const values = [];

  if (search) {
    where.push("(rm.number LIKE ? OR rm.description LIKE ?)");
    values.push(`%${search}%`, `%${search}%`);
  }

  if (is_available !== null && !Number.isNaN(is_available)) {
    where.push("rm.is_available = ?");
    values.push(is_available);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const [countRows] = await db.query(
    `SELECT COUNT(*) AS total FROM rooms rm ${whereSql}`,
    values,
  );
  const total = Number(countRows?.[0]?.total || 0);
  const [roomRows] = await db.query(
    `
    SELECT rm.*
    FROM rooms rm
    ${whereSql}
    ORDER BY rm.id ASC
    LIMIT ? OFFSET ?
    `,
    [...values, limit, offset],
  );
  if (!roomRows.length) {
    return { rooms: [], meta: { total, page, limit } };
  }
  const roomIds = roomRows.map((r) => r.id);
  const inPlaceholders = roomIds.map(() => "?").join(",");
  const [facRows] = await db.query(
    `
    SELECT
      rf.room_id,
      f.*
    FROM room_facilities rf
    JOIN facilities f ON f.id = rf.facility_id
    WHERE rf.room_id IN (${inPlaceholders})
    ORDER BY rf.room_id ASC, f.id ASC
    `,
    roomIds,
  );
  const [aggRows] = await db.query(
    `
    SELECT
      room_id,
      ROUND(AVG(rating), 1) AS review_avg,
      COUNT(*) AS review_count
    FROM reviews
    WHERE room_id IN (${inPlaceholders})
    GROUP BY room_id
    `,
    roomIds,
  );
  const facilitiesByRoom = new Map();
  for (const row of facRows) {
    const rid = row.room_id;
    const { room_id, ...facility } = row;

    if (!facilitiesByRoom.has(rid)) facilitiesByRoom.set(rid, []);
    facilitiesByRoom.get(rid).push(facility);
  }
  const aggByRoom = new Map();
  for (const a of aggRows) {
    aggByRoom.set(a.room_id, {
      review_avg: Number(a.review_avg || 0),
      review_count: Number(a.review_count || 0),
    });
  }
  const rooms = roomRows.map((rm) => {
    const agg = aggByRoom.get(rm.id) || { review_avg: 0, review_count: 0 };
    return {
      ...rm,
      facilities: facilitiesByRoom.get(rm.id) || [],
      ...agg,
    };
  });

  return { rooms, meta: { total, page, limit } };
}
async function deleteById(id) {
  await db.query(`DELETE FROM rooms WHERE id = ?`, [id]);
}

async function hasActiveLease(id) {
  const [rows] = await db.query(
    `SELECT id FROM leases WHERE room_id = ? AND status = 'active' LIMIT 1`,
    [id],
  );
  return rows.length > 0;
}
module.exports = {
  findAll,
  findById,
  findFacilitiesByRoomId,
  createRoom,
  updateRoomById,
  replaceRoomFacilities,
  findRoomsWithFacilitiesAndReviewAgg,
  roomstats,
  deleteById,
  hasActiveLease,
};
