const { ok, fail } = require("../utils/response");
const adminChatService = require("../services/adminChat.service");

async function chat(req, res) {
  try {
    const { question, history = [] } = req.body;

    if (!question || typeof question !== "string") {
      return fail(res, "question is required", 400);
    }

    const result = await adminChatService.adminChat({
      question: question.trim(),
      conversationHistory: Array.isArray(history) ? history : [],
    });

    return ok(res, result, "OK", 200);
  } catch (err) {
    return fail(res, err.message, err.statusCode || 500);
  }
}

module.exports = { chat };
