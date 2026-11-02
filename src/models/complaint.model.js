const db = require("../config/db");

async function createComplaint({ user_id, room_id, title, description }) {
  const [result] = await db.query(
    `
    INSERT INTO complaints (user_id, room_id, title, description, status)
    VALUES (?, ?, ?, ?, 'open')
    `,
    [user_id, room_id, title, description],
  );
  return result.insertId;
}

async function findByIdForUser({ id, user_id }) {
  const [rows] = await db.query(
    `
    SELECT
      c.*,
      r.number AS room_number,
      r.floor  AS room_floor
    FROM complaints c
    JOIN rooms r ON r.id = c.room_id
    WHERE c.id = ? AND c.user_id = ?
    LIMIT 1
    `,
    [id, user_id],
  );
  return rows[0] || null;
}

async function findAllForUser({ user_id, status, page = 1, limit = 10 }) {
  const p = Math.max(1, Number(page));
  const l = Math.min(100, Math.max(1, Number(limit)));
  const offset = (p - 1) * l;

  const where = ["c.user_id = ?"];
  const params = [user_id];

  if (status) {
    where.push("c.status = ?");
    params.push(status);
  }

  const whereSql = `WHERE ${where.join(" AND ")}`;

  const [rows] = await db.query(
    `
    SELECT
      c.id,
      c.room_id,
      c.title,
      c.description,
      c.status,
      c.created_at,
      c.closed_at,
      r.number AS room_number,
      r.floor  AS room_floor
    FROM complaints c
    JOIN rooms r ON r.id = c.room_id
    ${whereSql}
    ORDER BY c.created_at DESC, c.id DESC
    LIMIT ? OFFSET ?
    `,
    [...params, l, offset],
  );

  const [countRows] = await db.query(
    `SELECT COUNT(*) AS total FROM complaints c ${whereSql}`,
    params,
  );

  return { rows, total: countRows[0]?.total || 0, page: p, limit: l };
}

async function updateComplaintForUser({ id, user_id, data }) {
  const allowed = ["title", "description", "status", "closed_at"];
  const fields = [];
  const params = [];

  for (const key of allowed) {
    if (data[key] === undefined) continue;
    fields.push(`${key} = ?`);
    params.push(data[key]);
  }

  if (!fields.length) return;

  params.push(id, user_id);

  await db.query(
    `
    UPDATE complaints
    SET ${fields.join(", ")}
    WHERE id = ? AND user_id = ?
    `,
    params,
  );
}

async function findAll({ status, page = 1, limit = 10 }) {
  const p = Math.max(1, Number(page));
  const l = Math.min(100, Math.max(1, Number(limit)));
  const offset = (p - 1) * l;

  const where = [];
  const params = [];

  if (status) {
    where.push("c.status = ?");
    params.push(status);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const [rows] = await db.query(
    `
    SELECT
      c.id,
      c.room_id,
      c.title,
      c.description,
      c.status,
      c.created_at,
      c.closed_at,
      r.number AS room_number,
      r.floor  AS room_floor,
      u.name   AS tenant_name,
      u.email  AS tenant_email
    FROM complaints c
    JOIN rooms r ON r.id = c.room_id
    JOIN users u ON u.id = c.user_id
    ${whereSql}
    ORDER BY c.created_at DESC, c.id DESC
    LIMIT ? OFFSET ?
    `,
    [...params, l, offset],
  );

  const [countRows] = await db.query(
    `
    SELECT COUNT(*) AS total
    FROM complaints c
    ${whereSql}
    `,
    params,
  );

  return {
    rows,
    total: countRows[0]?.total || 0,
    page: p,
    limit: l,
  };
}
async function findByIdAdmin(id) {
  const [rows] = await db.query(
    `SELECT
       c.*,
       r.number AS room_number,
       r.floor  AS room_floor,
       u.name   AS tenant_name,
       u.email  AS tenant_email
     FROM complaints c
     JOIN rooms r ON r.id = c.room_id
     JOIN users u ON u.id = c.user_id
     WHERE c.id = ?
     LIMIT 1`,
    [id],
  );
  return rows[0] || null;
}

async function updateComplaintAdmin(id, data) {
  const fields = [];
  const params = [];

  if (data.status !== undefined) {
    fields.push("status = ?");
    params.push(data.status);

    if (data.status === "closed") {
      fields.push("closed_at = ?");
      params.push(new Date());
    } else {
      fields.push("closed_at = ?");
      params.push(null);
    }
  }

  if (!fields.length) return;

  params.push(id);
  await db.query(
    `UPDATE complaints SET ${fields.join(", ")} WHERE id = ?`,
    params,
  );
}
module.exports = {
  createComplaint,
  findByIdForUser,
  findAllForUser,
  updateComplaintForUser,
  findAll,
  findByIdAdmin,
  updateComplaintAdmin,
};
