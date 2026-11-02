const db = require("../config/db");

async function getCache(roomId, type) {
  const [rows] = await db.query(
    `SELECT result, generated_at, expires_at
     FROM ai_cache
     WHERE room_id = ? AND type = ?
       AND expires_at > NOW()
     LIMIT 1`,
    [roomId, type],
  );
  if (!rows.length) return null;
  return {
    ...JSON.parse(rows[0].result),
    _cached: true,
    _generated_at: rows[0].generated_at,
    _expires_at: rows[0].expires_at,
  };
}

async function getCacheStale(roomId, type) {
  const [rows] = await db.query(
    `SELECT result, generated_at, expires_at
     FROM ai_cache
     WHERE room_id = ? AND type = ?
     ORDER BY generated_at DESC
     LIMIT 1`,
    [roomId, type],
  );
  if (!rows.length) return null;
  return {
    ...JSON.parse(rows[0].result),
    _cached: true,
    _stale: true,
    _generated_at: rows[0].generated_at,
    _expires_at: rows[0].expires_at,
  };
}

async function setCache(roomId, type, result, ttlHours = 6) {
  await db.query(
    `INSERT INTO ai_cache (room_id, type, result, generated_at, expires_at)
     VALUES (?, ?, ?, NOW(), DATE_ADD(NOW(), INTERVAL ? HOUR))
     ON DUPLICATE KEY UPDATE
       result       = VALUES(result),
       generated_at = NOW(),
       expires_at   = DATE_ADD(NOW(), INTERVAL ? HOUR)`,
    [roomId, type, JSON.stringify(result), ttlHours, ttlHours],
  );
}

async function invalidateCache(roomId, type = null) {
  if (type) {
    await db.query(`DELETE FROM ai_cache WHERE room_id = ? AND type = ?`, [
      roomId,
      type,
    ]);
  } else {
    await db.query(`DELETE FROM ai_cache WHERE room_id = ?`, [roomId]);
  }
}

module.exports = { getCache, getCacheStale, setCache, invalidateCache };
