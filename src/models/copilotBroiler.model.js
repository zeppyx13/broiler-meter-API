const db = require("../config/db");

async function conversation(id, userId, connection = db, lock = false) {
  const sql = lock
    ? "SELECT * FROM ai_conversations WHERE id = ? AND user_id = ? FOR UPDATE"
    : "SELECT * FROM ai_conversations WHERE id = ? AND user_id = ?";
  const [rows] = await connection.query(sql, [id, userId]);
  return rows[0] || null;
}

async function conversations(
  userId,
  coopId,
  { limit, before_id },
  connection = db,
) {
  const [rows] = await connection.query(
    `SELECT id, coop_id, flock_cycle_id, title, created_at, updated_at
     FROM ai_conversations WHERE user_id = ? AND coop_id = ?
       AND (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?`,
    [userId, coopId, before_id || null, before_id || null, limit],
  );
  return rows;
}

async function create(data, connection = db) {
  const [result] = await connection.query(
    "INSERT INTO ai_conversations (user_id, coop_id, flock_cycle_id, title) VALUES (?, ?, ?, ?)",
    [data.user_id, data.coop_id, data.flock_cycle_id || null, data.title],
  );
  return result.insertId;
}

async function messages(
  conversationId,
  { limit = 10, before_id } = {},
  connection = db,
) {
  const [rows] = await connection.query(
    `SELECT id, role, content, context_json, created_at FROM ai_messages
     WHERE conversation_id = ? AND (? IS NULL OR id < ?)
       AND role IN ('user', 'assistant') ORDER BY id DESC LIMIT ?`,
    [conversationId, before_id || null, before_id || null, limit],
  );
  return rows;
}

async function turnByRequest(userId, coopId, requestId, connection = db) {
  const [rows] = await connection.query(
    `SELECT m.id, m.conversation_id, m.role, m.content, m.context_json, m.created_at
     FROM ai_messages m JOIN ai_conversations c ON c.id = m.conversation_id
     WHERE c.user_id = ? AND c.coop_id = ? AND m.role = 'assistant'
       AND JSON_UNQUOTE(JSON_EXTRACT(m.context_json, '$.request_id')) = ?
     ORDER BY m.id DESC LIMIT 1`,
    [userId, coopId, requestId],
  );
  return rows[0] || null;
}

async function insertMessage(
  conversationId,
  role,
  content,
  context,
  connection,
) {
  const [result] = await connection.query(
    "INSERT INTO ai_messages (conversation_id, role, content, context_json) VALUES (?, ?, ?, ?)",
    [conversationId, role, content, JSON.stringify(context)],
  );
  return result.insertId;
}

async function touch(id, connection) {
  await connection.query(
    "UPDATE ai_conversations SET updated_at = UTC_TIMESTAMP() WHERE id = ?",
    [id],
  );
}

async function recentTurns(userId, connection = db) {
  const [[row]] = await connection.query(
    `SELECT COUNT(*) AS count FROM ai_messages m
     JOIN ai_conversations c ON c.id = m.conversation_id
     WHERE c.user_id = ? AND m.role = 'user'
       AND m.created_at >= UTC_TIMESTAMP() - INTERVAL 1 HOUR`,
    [userId],
  );
  return Number(row.count);
}

async function acquire(userId, connection) {
  const [[row]] = await connection.query("SELECT GET_LOCK(?, 0) AS acquired", [
    `coasther:copilot:${userId}`,
  ]);
  return Number(row.acquired) === 1;
}

async function release(userId, connection) {
  await connection.query("SELECT RELEASE_LOCK(?)", [
    `coasther:copilot:${userId}`,
  ]);
}

module.exports = {
  conversation,
  conversations,
  create,
  messages,
  turnByRequest,
  insertMessage,
  touch,
  recentTurns,
  acquire,
  release,
};
