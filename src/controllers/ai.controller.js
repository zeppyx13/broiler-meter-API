const { ok, fail } = require("../utils/response");
const aiService = require("../services/ai.service");

async function getRoomInsight(req, res) {
  try {
    const roomId = Number(req.params.roomId);
    const days = Number(req.query.days) || 30;
    const forceRefresh = req.query.refresh === "true";
    const result = await aiService.generateRoomInsight({
      roomId,
      days,
      forceRefresh,
    });
    return ok(res, result, "OK", 200);
  } catch (err) {
    return fail(res, err.message, err.statusCode || 500);
  }
}

async function getRoomPrediction(req, res) {
  try {
    const roomId = Number(req.params.roomId);
    const forceRefresh = req.query.refresh === "true";
    const result = await aiService.generateRoomPrediction({
      roomId,
      forceRefresh,
    });
    return ok(res, result, "OK", 200);
  } catch (err) {
    return fail(res, err.message, err.statusCode || 500);
  }
}

async function streamRoomInsight(req, res) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const roomId = Number(req.params.roomId);
  const days = Number(req.query.days) || 30;
  const forceRefresh = req.query.refresh === "true";

  try {
    for await (const event of aiService.streamRoomInsight({ roomId, days, forceRefresh })) {
      if (event.type === "chunk") {
        res.write(`data: ${JSON.stringify({ chunk: event.text })}\n\n`);
      } else if (event.type === "done") {
        res.write(`event: done\ndata: ${JSON.stringify(event.result)}\n\n`);
        res.end();
      }
    }
  } catch (err) {
    res.write(`event: error\ndata: ${JSON.stringify({ message: err.message, statusCode: err.statusCode || 500 })}\n\n`);
    res.end();
  }
}

async function streamRoomPrediction(req, res) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const roomId = Number(req.params.roomId);
  const forceRefresh = req.query.refresh === "true";

  try {
    for await (const event of aiService.streamRoomPrediction({ roomId, forceRefresh })) {
      if (event.type === "chunk") {
        res.write(`data: ${JSON.stringify({ chunk: event.text })}\n\n`);
      } else if (event.type === "done") {
        res.write(`event: done\ndata: ${JSON.stringify(event.result)}\n\n`);
        res.end();
      }
    }
  } catch (err) {
    res.write(`event: error\ndata: ${JSON.stringify({ message: err.message, statusCode: err.statusCode || 500 })}\n\n`);
    res.end();
  }
}

module.exports = { getRoomInsight, getRoomPrediction, streamRoomInsight, streamRoomPrediction };
