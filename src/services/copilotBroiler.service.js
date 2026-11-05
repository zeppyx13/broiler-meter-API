const crypto = require("node:crypto");
const db = require("../config/db");
const model = require("../models/copilotBroiler.model");
const users = require("../models/user.model");
const access = require("./access.service");
const analytics = require("./analyticsContext.service");
const contextService = require("./copilotContextBroiler.service");
const provider = require("./geminiBroiler.service");
const httpError = require("../utils/httpError");

let active = 0;
const attempts = new Map();
const MAX_CONCURRENT = 2;

function json(value) {
  try {
    return typeof value === "string" ? JSON.parse(value) : value || {};
  } catch {
    return {};
  }
}

async function actor(user, connection) {
  const current = await users.findById(user.id, connection);
  if (
    !current ||
    !["admin", "manager", "operator"].includes(current.role) ||
    !current.is_verified
  )
    throw httpError(401, "Account is unavailable");
  return current;
}

async function ownConversation(user, id, connection, lock = false) {
  const conversation = await model.conversation(id, user.id, connection, lock);
  if (!conversation) throw httpError(404, "Conversation not found");
  return conversation;
}

function presentMessage(row) {
  const context = json(row.context_json);
  return {
    id: row.id,
    role: row.role,
    content: provider.cleanText(row.content),
    created_at: row.created_at,
    context: {
      source: context.source || "unknown",
      is_simulated: context.source === "simulation",
      as_of: context.as_of || null,
      request_id: context.request_id || null,
    },
  };
}

function answer(row, reused = false) {
  const context = json(row.context_json);
  return {
    state: "ready",
    conversation_id: row.conversation_id,
    request_id: context.request_id,
    source: context.source,
    is_simulated: context.source === "simulation",
    as_of: context.as_of,
    message: presentMessage(row),
    reused,
    advisory_only: true,
    actions_executed: false,
  };
}

async function list(user, query) {
  const current = await actor(user);
  return analytics.withContext(
    current,
    { coop_id: query.coop_id },
    async (context, connection) => {
      if (!context.coop)
        return { state: "no_coop", conversations: [], next_before_id: null };
      const rows = await model.conversations(
        current.id,
        context.coop.id,
        query,
        connection,
      );
      return {
        state: "ready",
        coop_id: context.coop.id,
        conversations: rows,
        next_before_id: rows.length === query.limit ? rows.at(-1).id : null,
      };
    },
  );
}

async function create(user, input) {
  const current = await actor(user);
  return analytics.withContext(
    current,
    { coop_id: input.coop_id },
    async (context, connection) => {
      if (!context.coop)
        throw httpError(409, "No accessible coop is available");
      const id = await model.create(
        {
          user_id: current.id,
          coop_id: context.coop.id,
          flock_cycle_id: context.cycle?.id,
          title: provider.cleanText(input.title || "Percakapan kandang", 160),
        },
        connection,
      );
      const row = await ownConversation(current, id, connection);
      const { user_id, ...result } = row;
      return result;
    },
  );
}

async function detail(user, id) {
  const current = await actor(user);
  const conversation = await ownConversation(current, id);
  await access.requireCoop(current, conversation.coop_id);
  const { user_id, ...result } = conversation;
  return result;
}

async function messages(user, id, query) {
  const current = await actor(user);
  const conversation = await ownConversation(current, id);
  await access.requireCoop(current, conversation.coop_id);
  const rows = await model.messages(id, query);
  return {
    conversation_id: id,
    messages: rows.map(presentMessage),
    order: "newest_first",
    next_before_id: rows.length === query.limit ? rows.at(-1).id : null,
  };
}

function limited(userId) {
  const now = Date.now();
  for (const [key, value] of attempts)
    if (now - value.started >= 3600000) attempts.delete(key);
  let current = attempts.get(userId);
  if (!current) {
    if (attempts.size >= 1024) attempts.delete(attempts.keys().next().value);
    current = { started: now, count: 0 };
    attempts.set(userId, current);
  }
  if (current.count >= 10) return true;
  current.count += 1;
  return false;
}

function checkRetry(row, input, hash) {
  const saved = json(row.context_json);
  if (
    saved.input_hash !== hash ||
    saved.source !== input.source ||
    (input.conversation_id &&
      Number(row.conversation_id) !== Number(input.conversation_id))
  ) {
    throw httpError(
      409,
      "request_id has already been used for a different turn",
    );
  }
  return answer(row, true);
}

async function send(user, input) {
  const current = await actor(user);
  let conversation = input.conversation_id
    ? await ownConversation(current, input.conversation_id)
    : null;
  if (
    conversation &&
    input.coop_id &&
    Number(input.coop_id) !== Number(conversation.coop_id)
  )
    throw httpError(409, "Conversation belongs to another coop");
  const query = {
    coop_id: conversation?.coop_id || input.coop_id,
    source: input.source || "real",
  };
  // Reserve process capacity before taking a dedicated named-lock connection; never exhaust the pool waiting for Gemini.
  if (active >= MAX_CONCURRENT)
    return provider.unavailable("provider_busy", true);
  active += 1;
  let connection;
  let acquired = false;
  const requestId = input.request_id || crypto.randomUUID();
  const inputHash = crypto
    .createHash("sha256")
    .update(JSON.stringify([query.source, input.message]))
    .digest("hex");
  try {
    connection = await db.getConnection();
    acquired = await model.acquire(current.id, connection);
    if (!acquired)
      return {
        ...provider.unavailable("conversation_busy", true),
        request_id: requestId,
      };
    const loaded = await contextService.load(current, query);
    const context = loaded.context;
    if (!context.coop)
      return { ...provider.unavailable("no_coop"), request_id: requestId };
    const prior = await model.turnByRequest(
      current.id,
      context.coop.id,
      requestId,
      connection,
    );
    if (prior)
      return checkRetry(prior, { ...input, source: query.source }, inputHash);
    if (
      conversation &&
      Number(conversation.flock_cycle_id || 0) !==
        Number(context.cycle?.id || 0)
    )
      throw httpError(
        409,
        "The active cycle changed; create a new conversation",
      );
    const rows = conversation
      ? await model.messages(conversation.id, { limit: 10 }, connection)
      : [];
    if (rows.some((row) => json(row.context_json).source !== query.source))
      throw httpError(
        409,
        "Use a separate conversation for real and simulation sources",
      );
    if (!provider.configured())
      return {
        ...provider.unavailable("not_configured"),
        request_id: requestId,
        source: query.source,
      };
    if (
      limited(current.id) ||
      (await model.recentTurns(current.id, connection)) >= 10
    )
      return {
        ...provider.unavailable("user_rate_limited", true),
        request_id: requestId,
      };
    let historyChars = 0;
    const history = rows
      .filter((row) => ["user", "assistant"].includes(row.role))
      .filter((row) => {
        historyChars += Math.min(
          String(row.content).length,
          row.role === "user" ? 2000 : 4000,
        );
        return historyChars <= 6000;
      })
      .reverse();
    const generated = await provider.generate({
      context: loaded.summary,
      history,
      message: input.message,
    });
    if (generated.state !== "ready")
      return { ...generated, request_id: requestId, source: query.source };
    const text = provider.cleanText(generated.text);
    if (!text)
      return {
        ...provider.unavailable("invalid_provider_response"),
        request_id: requestId,
      };
    // The provider ran without a transaction. Reauthorize and persist both messages in one short parent-locked transaction.
    const refreshed = await actor(current, connection);
    return analytics.withContext(
      refreshed,
      { coop_id: context.coop.id, source: query.source },
      async (latest, transaction) => {
        // This independent autocommit read sees role revocation even after the analytics transaction's RR snapshot began.
        const finalActor = await actor(refreshed, connection);
        await access.requireCoop(
          finalActor,
          context.coop.id,
          "read",
          transaction,
        );
        if (contextService.cohort(latest) !== loaded.cohort)
          return {
            ...provider.unavailable("context_changed", true),
            request_id: requestId,
          };
        if (conversation) {
          conversation = await ownConversation(
            finalActor,
            conversation.id,
            transaction,
            true,
          );
        } else {
          const id = await model.create(
            {
              user_id: current.id,
              coop_id: context.coop.id,
              flock_cycle_id: context.cycle?.id,
              title: "Percakapan kandang",
            },
            transaction,
          );
          conversation = { id };
        }
        const meta = {
          version: 1,
          request_id: requestId,
          source: query.source,
          is_simulated: query.source === "simulation",
          as_of: context.generated_at,
          context_fingerprint: context.fingerprint,
          cohort: loaded.cohort,
          input_hash: inputHash,
          advisory_only: true,
        };
        const userText = provider.cleanText(input.message, 2000);
        const assistantText =
          query.source === "simulation"
            ? `SIMULATION — data demonstrasi sintetis.\n${text}`
            : text;
        await model.insertMessage(
          conversation.id,
          "user",
          userText,
          meta,
          transaction,
        );
        const id = await model.insertMessage(
          conversation.id,
          "assistant",
          assistantText,
          meta,
          transaction,
        );
        await model.touch(conversation.id, transaction);
        return answer({
          id,
          conversation_id: conversation.id,
          role: "assistant",
          content: assistantText,
          context_json: meta,
          created_at: new Date(),
        });
      },
    );
  } finally {
    try {
      if (connection) {
        try {
          if (acquired) await model.release(current.id, connection);
          connection.release();
        } catch {
          // A connection with an unreleased advisory lock must not return to the pool.
          connection.destroy();
        }
      }
    } finally {
      active -= 1;
    }
  }
}

module.exports = { list, create, detail, messages, send };
