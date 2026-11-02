const { GoogleGenAI } = require("@google/genai");
const aiModel = require("../models/ai.model");
const feeModel = require("../models/fee.model");
const aiCacheModel = require("../models/aicache.model");
const logger = require("../config/logger");

const INSIGHT_TTL_HOURS = Number(process.env.INSIGHT_TTL_HOURS);
const PREDICTION_TTL_HOURS = Number(process.env.PREDICTION_TTL_HOURS);

// =====================================================
// UTILITIES
// =====================================================
function httpError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toNumber3(x) {
  const n = Number(x || 0);
  return Math.round(n * 1000) / 1000;
}

function getDaysInfo() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const today = now.getDate();
  const totalDays = new Date(year, month + 1, 0).getDate();
  const remaining = totalDays - today;
  return { today, totalDays, remaining };
}

// =====================================================
// GEMINI SINGLETON
// =====================================================
const _aiClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

function getAiClient() {
  return _aiClient;
}

// =====================================================
// INSIGHT HELPERS
// =====================================================
function buildUsageMap(rows) {
  const byType = { electric: [], water: [] };

  for (const row of rows) {
    const rawValue = toNumber(row.usage_value);
    const rawFirst = toNumber(row.first_reading);
    const rawLast = toNumber(row.last_reading);
    const isWater = row.type === "water";

    const item = {
      date: row.usage_date,
      usage_value: isWater ? Number((rawValue / 1000).toFixed(3)) : rawValue,
      unit: isWater ? "m3" : row.unit,
      sample_count: toNumber(row.sample_count),
      first_reading: isWater ? Number((rawFirst / 1000).toFixed(3)) : rawFirst,
      last_reading: isWater ? Number((rawLast / 1000).toFixed(3)) : rawLast,
    };

    if (row.type === "electric") byType.electric.push(item);
    if (row.type === "water") byType.water.push(item);
  }

  return byType;
}

function calcStats(items) {
  if (!items.length) {
    return {
      total: 0,
      avg_daily: 0,
      peak_day: null,
      peak_value: 0,
      recent_7_total: 0,
      previous_7_total: 0,
      trend_percent: 0,
    };
  }

  const total = items.reduce((sum, x) => sum + x.usage_value, 0);
  const avgDaily = total / items.length;

  let peak = items[0];
  for (const item of items) {
    if (item.usage_value > peak.usage_value) peak = item;
  }

  const recent7 = items.slice(-7);
  const previous7 = items.slice(-14, -7);
  const recent7Total = recent7.reduce((sum, x) => sum + x.usage_value, 0);
  const previous7Total = previous7.reduce((sum, x) => sum + x.usage_value, 0);

  let trendPercent = 0;
  if (previous7Total > 0) {
    trendPercent = ((recent7Total - previous7Total) / previous7Total) * 100;
  }

  return {
    total: Number(total.toFixed(3)),
    avg_daily: Number(avgDaily.toFixed(3)),
    peak_day: peak.date || null,
    peak_value: Number(peak.usage_value.toFixed(3)),
    recent_7_total: Number(recent7Total.toFixed(3)),
    previous_7_total: Number(previous7Total.toFixed(3)),
    trend_percent: Number(trendPercent.toFixed(2)),
  };
}

// =====================================================
// PROMPT BUILDERS
// =====================================================
function buildInsightPrompt({
  roomId,
  days,
  latestMeters,
  electricStats,
  waterStats,
  dailyUsage,
}) {
  // strip latestMeters to semantic fields only
  const metersForPrompt = latestMeters.map((m) => ({
    type: m.type,
    latest_value: m.latest_value,
    unit: m.unit,
    recorded_at: m.recorded_at,
  }));

  // strip dailyUsage to date + usage_value only
  const usageForPrompt = {
    electric: dailyUsage.electric.map((d) => ({
      date: d.date,
      usage_value: d.usage_value,
    })),
    water: dailyUsage.water.map((d) => ({
      date: d.date,
      usage_value: d.usage_value,
    })),
  };

  return `
Kamu adalah analis penggunaan utilitas untuk aplikasi kost Coasther.

Tugas:
1. Analisis data penggunaan listrik dan air kamar.
2. Fokus pada pola boros, lonjakan, tren naik/turun, dan hari puncak.
3. Berikan insight yang singkat, tajam, dan praktis.
4. Jangan membuat angka baru. Gunakan hanya data yang tersedia.
5. Jika data kurang, nyatakan dengan jujur.

Konteks:
- room_id: ${roomId}
- periode_analisis_hari: ${days}

latest_meters:
${JSON.stringify(metersForPrompt, null, 2)}

electric_stats:
${JSON.stringify(electricStats, null, 2)}

water_stats:
${JSON.stringify(waterStats, null, 2)}

daily_usage:
${JSON.stringify(usageForPrompt, null, 2)}

Keluarkan JSON yang sesuai schema.
`;
}

// billing pre-calculated, passed as billingEstimate
function buildPredictionPrompt({
  roomId,
  history,
  currentUsage,
  daysInfo,
  billingEstimate,
}) {
  const historyConverted = history.map((h) => ({
    month: h.month,
    water_used_m3: toNumber3(Number(h.water_used) / 1000),
    elec_used_kwh: toNumber3(Number(h.elec_used)),
  }));

  const currentConverted = currentUsage.map((c) => ({
    type: c.type,
    used_so_far:
      c.type === "water"
        ? toNumber3(Number(c.used_so_far) / 1000)
        : toNumber3(Number(c.used_so_far)),
    unit: c.type === "water" ? "m3" : "kWh",
  }));

  return `
Kamu adalah sistem prediksi konsumsi utilitas untuk aplikasi manajemen kost Coasther.

Tugas:
1. Analisis histori pemakaian air dan listrik 6 bulan terakhir.
2. Hitung rata-rata harian berdasarkan pemakaian bulan berjalan sampai hari ini.
3. Prediksi total pemakaian air (m³) dan listrik (kWh) hingga akhir bulan.
4. Berikan confidence level prediksi (low/medium/high) berdasarkan konsistensi data histori.
5. Gunakan estimasi tagihan yang sudah dihitung sebagai konteks. Jangan menghitung ulang tarif.
6. Jangan membuat angka baru selain dari kalkulasi data yang tersedia.

Data:
- room_id        : ${roomId}
- Hari ini       : ${daysInfo.today} dari ${daysInfo.totalDays} hari
- Sisa hari      : ${daysInfo.remaining} hari

Histori 6 bulan (water_used_m3 = m³, elec_used_kwh = kWh):
${JSON.stringify(historyConverted, null, 2)}

Pemakaian bulan berjalan (sampai hari ini):
${JSON.stringify(currentConverted, null, 2)}

Estimasi tagihan bulan ini (berdasarkan proyeksi pemakaian penuh):
- Sewa          : Rp ${billingEstimate.rent.toLocaleString("id-ID")}
- Air           : Rp ${billingEstimate.waterCost.toLocaleString("id-ID")}
- Listrik       : Rp ${billingEstimate.elecCost.toLocaleString("id-ID")}
- Total estimasi: Rp ${billingEstimate.estimatedTotal.toLocaleString("id-ID")}

Keluarkan JSON sesuai schema yang diberikan.
`;
}

// GEMINI CALL WITH RETRY
const RETRY_CONFIG = {
  maxAttempts: parseInt(process.env.GEMINI_MAX_ATTEMPTS) || 3,
  baseDelayMs: parseInt(process.env.GEMINI_BASE_DELAY_MS) || 1000,
  maxDelayMs: parseInt(process.env.GEMINI_MAX_DELAY_MS) || 10000,
  retryableStatuses: new Set([429, 500, 502, 503, 504]),
};

function isRetryableError(err) {
  if (!err.statusCode && !err.status) return true;
  return RETRY_CONFIG.retryableStatuses.has(err.statusCode ?? err.status);
}

async function callGeminiWithRetry(prompt, schema) {
  const client = getAiClient();
  let lastErr;

  for (let attempt = 1; attempt <= RETRY_CONFIG.maxAttempts; attempt++) {
    try {
      const response = await client.models.generateContent({
        model: process.env.GEMINI_MODEL,
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseJsonSchema: schema,
        },
      });
      try {
        return JSON.parse(response.text);
      } catch {
        throw httpError("Gemini returned invalid JSON", 502);
      }
    } catch (err) {
      lastErr = err;
      if (!isRetryableError(err) || attempt === RETRY_CONFIG.maxAttempts) break;

      const jitter = Math.random() * 300;
      const delay = Math.min(
        RETRY_CONFIG.baseDelayMs * 2 ** (attempt - 1) + jitter,
        RETRY_CONFIG.maxDelayMs,
      );
      logger.warn(
        `[AI] Gemini attempt ${attempt} failed (${err.message}), retry in ${Math.round(delay)}ms`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

async function* streamGemini(prompt, schema) {
  const client = getAiClient();
  const stream = client.models.generateContentStream({
    model: process.env.GEMINI_MODEL,
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseJsonSchema: schema,
    },
  });

  let fullText = "";
  for await (const chunk of stream) {
    const text = chunk.text ?? "";
    if (text) {
      fullText += text;
      yield { type: "chunk", text };
    }
  }

  try {
    yield { type: "done", parsed: JSON.parse(fullText) };
  } catch {
    throw httpError("Gemini returned invalid JSON", 502);
  }
}

// =====================================================
// SCHEMAS
// =====================================================
const insightSchema = {
  type: "object",
  properties: {
    summary: {
      type: "string",
      description: "Ringkasan umum kondisi penggunaan kamar.",
    },
    key_findings: {
      type: "array",
      description: "Temuan utama dari data penggunaan.",
      items: { type: "string" },
    },
    anomalies: {
      type: "array",
      description: "Lonjakan atau pola tidak biasa. Kosongkan jika tidak ada.",
      items: { type: "string" },
    },
    recommendations: {
      type: "array",
      description: "Saran hemat atau tindakan lanjutan yang konkret.",
      items: { type: "string" },
    },
    risk_level: {
      type: "string",
      enum: ["low", "medium", "high"],
      description: "Tingkat risiko pemborosan berdasarkan data.",
    },
  },
  required: [
    "summary",
    "key_findings",
    "anomalies",
    "recommendations",
    "risk_level",
  ],
};

const predictionSchema = {
  type: "object",
  properties: {
    water: {
      type: "object",
      properties: {
        used_so_far_m3: { type: "number" },
        predicted_total_m3: { type: "number" },
        daily_avg_m3: { type: "number" },
      },
    },
    electricity: {
      type: "object",
      properties: {
        used_so_far_kwh: { type: "number" },
        predicted_total_kwh: { type: "number" },
        daily_avg_kwh: { type: "number" },
      },
    },
    billing: {
      type: "object",
      properties: {
        rent: { type: "number" },
        water_cost: { type: "number" },
        electricity_cost: { type: "number" },
        estimated_total: { type: "number" },
        compared_last_month: { type: "string" },
      },
    },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    summary: { type: "string" },
    tips: { type: "array", items: { type: "string" } },
  },
};

// =====================================================
// IN-FLIGHT DEDUPLICATION
// =====================================================
const _inFlight = new Map();
const PROMPT_MAX_CHARS = process.env.PROMPT_MAX_CHARS;
async function _doGenerateInsight({ roomId, days, staleCache }) {
  try {
    const [dailyRows, latestMeters] = await Promise.all([
      aiModel.getDailyUsageByRoom(roomId, days),
      aiModel.getLatestMetersByRoom(roomId),
    ]);

    if (!latestMeters.length) {
      throw httpError("No active meters found for this room", 404);
    }

    const usageMap = buildUsageMap(dailyRows);
    const electricStats = calcStats(usageMap.electric);
    const waterStats = calcStats(usageMap.water);

    let prompt = buildInsightPrompt({
      roomId,
      days,
      latestMeters,
      electricStats,
      waterStats,
      dailyUsage: usageMap,
    });

    //soft guard: trim to last 14 days if prompt too large
    if (prompt.length > PROMPT_MAX_CHARS) {
      logger.warn(
        `[AI] Insight prompt too large (${prompt.length} chars) for room ${roomId}, trimming dailyUsage`,
      );
      const trimmedUsage = {
        electric: usageMap.electric.slice(-14),
        water: usageMap.water.slice(-14),
      };
      prompt = buildInsightPrompt({
        roomId,
        days,
        latestMeters,
        electricStats,
        waterStats,
        dailyUsage: trimmedUsage,
      });
    }

    const insight = await callGeminiWithRetry(prompt, insightSchema);

    const result = {
      room_id: Number(roomId),
      period_days: Number(days),
      latest_meters: latestMeters,
      stats: { electric: electricStats, water: waterStats },
      insight,
    };

    await aiCacheModel.setCache(roomId, "insight", result, INSIGHT_TTL_HOURS);
    return result;
  } catch (err) {
    if (!err.statusCode || err.statusCode >= 500) {
      logger.error(
        `[AI] Insight generation failed room ${roomId}: ${err.message}`,
      );

      if (staleCache) {
        logger.warn(
          `[AI] Returning stale cache for room ${roomId} insight (Gemini unavailable)`,
        );
        return staleCache;
      }

      throw httpError("Layanan AI sedang sibuk, coba beberapa menit lagi", 503);
    }

    throw err;
  }
}

async function _doGeneratePrediction({ roomId, staleCache }) {
  try {
    const [history, currentUsage, roomPrice, tariff] = await Promise.all([
      aiModel.getUsageHistory(roomId, 6),
      aiModel.getCurrentMonthUsage(roomId),
      aiModel.getRoomPrice(roomId),
      feeModel.getfreequota(),
    ]);

    if (!roomPrice) throw httpError("Room not found", 404);

    // Masalah 3 — pre-calculate billing in Node before building prompt
    const waterM3 = toNumber3(
      (currentUsage.find((c) => c.type === "water")?.used_so_far ?? 0) / 1000,
    );
    const elecKwh = toNumber3(
      currentUsage.find((c) => c.type === "electric")?.used_so_far ?? 0,
    );
    const rent = toNumber(roomPrice.price_monthly);
    const waterCost =
      Math.max(0, waterM3 - toNumber(tariff.waterQuota)) *
      toNumber(tariff.waterRate);
    const elecCost =
      Math.max(0, elecKwh - toNumber(tariff.electricQuota)) *
      toNumber(tariff.electricRate);
    const billingEstimate = {
      rent,
      waterCost: Math.round(waterCost),
      elecCost: Math.round(elecCost),
      estimatedTotal: Math.round(rent + waterCost + elecCost),
    };

    const daysInfo = getDaysInfo();
    const prompt = buildPredictionPrompt({
      roomId,
      history,
      currentUsage,
      daysInfo,
      billingEstimate,
    });

    const prediction = await callGeminiWithRetry(prompt, predictionSchema);

    const result = {
      room_id: Number(roomId),
      days_info: daysInfo,
      prediction,
    };

    await aiCacheModel.setCache(
      roomId,
      "prediction",
      result,
      PREDICTION_TTL_HOURS,
    );

    return result;
  } catch (err) {
    if (!err.statusCode || err.statusCode >= 500) {
      logger.error(
        `[AI] Prediction generation failed room ${roomId}: ${err.message}`,
      );

      if (staleCache) {
        logger.warn(
          `[AI] Returning stale cache for room ${roomId} prediction (Gemini unavailable)`,
        );
        return staleCache;
      }

      throw httpError("Layanan AI sedang sibuk, coba beberapa menit lagi", 503);
    }
    throw err;
  }
}

// =====================================================
// PUBLIC FUNCTIONS
// =====================================================
async function generateRoomInsight({
  roomId,
  days = 30,
  forceRefresh = false,
}) {
  if (!roomId || Number.isNaN(Number(roomId))) {
    throw httpError("Invalid room id", 400);
  }

  if (!forceRefresh) {
    const cached = await aiCacheModel.getCache(roomId, "insight");
    if (cached) {
      logger.info(`[AI] Insight cache hit — room ${roomId}`);
      return cached;
    }
  }

  // IN-FLIGHT DEDUPLICATION — check in-flight before fetching stale cache
  const inflightKey = `insight:${roomId}`;
  if (_inFlight.has(inflightKey)) {
    logger.info(`[AI] Insight in-flight hit — room ${roomId}`);
    return _inFlight.get(inflightKey);
  }

  const staleCache = await aiCacheModel.getCacheStale(roomId, "insight");
  logger.info(`[AI] Generating insight — room ${roomId}`);

  const promise = _doGenerateInsight({ roomId, days, staleCache }).finally(() =>
    _inFlight.delete(inflightKey),
  );

  _inFlight.set(inflightKey, promise);
  return promise;
}

async function generateRoomPrediction({ roomId, forceRefresh = false }) {
  if (!roomId || Number.isNaN(Number(roomId))) {
    throw httpError("Invalid room id", 400);
  }

  if (!forceRefresh) {
    const cached = await aiCacheModel.getCache(roomId, "prediction");
    if (cached) {
      logger.info(`[AI] Prediction cache hit — room ${roomId}`);
      return cached;
    }
  }

  // IN-FLIGHT DEDUPLICATION — check in-flight before fetching stale cache
  const inflightKey = `prediction:${roomId}`;
  if (_inFlight.has(inflightKey)) {
    logger.info(`[AI] Prediction in-flight hit — room ${roomId}`);
    return _inFlight.get(inflightKey);
  }

  const staleCache = await aiCacheModel.getCacheStale(roomId, "prediction");
  logger.info(`[AI] Generating prediction — room ${roomId}`);

  const promise = _doGeneratePrediction({ roomId, staleCache }).finally(() =>
    _inFlight.delete(inflightKey),
  );

  _inFlight.set(inflightKey, promise);
  return promise;
}

// =====================================================
// STREAMING PUBLIC FUNCTIONS
// =====================================================
async function* streamRoomInsight({ roomId, days = 30, forceRefresh = false }) {
  if (!roomId || Number.isNaN(Number(roomId))) {
    throw httpError("Invalid room id", 400);
  }

  if (!forceRefresh) {
    const cached = await aiCacheModel.getCache(roomId, "insight");
    if (cached) {
      logger.info(`[AI] Insight cache hit (stream) — room ${roomId}`);
      yield { type: "done", result: cached, cached: true };
      return;
    }
  }

  const [dailyRows, latestMeters] = await Promise.all([
    aiModel.getDailyUsageByRoom(roomId, days),
    aiModel.getLatestMetersByRoom(roomId),
  ]);

  if (!latestMeters.length) throw httpError("No active meters found for this room", 404);

  const usageMap = buildUsageMap(dailyRows);
  const electricStats = calcStats(usageMap.electric);
  const waterStats = calcStats(usageMap.water);

  let prompt = buildInsightPrompt({ roomId, days, latestMeters, electricStats, waterStats, dailyUsage: usageMap });
  if (prompt.length > PROMPT_MAX_CHARS) {
    const trimmedUsage = { electric: usageMap.electric.slice(-14), water: usageMap.water.slice(-14) };
    prompt = buildInsightPrompt({ roomId, days, latestMeters, electricStats, waterStats, dailyUsage: trimmedUsage });
  }

  logger.info(`[AI] Streaming insight — room ${roomId}`);
  for await (const event of streamGemini(prompt, insightSchema)) {
    if (event.type === "chunk") {
      yield event;
    } else if (event.type === "done") {
      const result = {
        room_id: Number(roomId),
        period_days: Number(days),
        latest_meters: latestMeters,
        stats: { electric: electricStats, water: waterStats },
        insight: event.parsed,
      };
      await aiCacheModel.setCache(roomId, "insight", result, INSIGHT_TTL_HOURS);
      yield { type: "done", result };
    }
  }
}

async function* streamRoomPrediction({ roomId, forceRefresh = false }) {
  if (!roomId || Number.isNaN(Number(roomId))) {
    throw httpError("Invalid room id", 400);
  }

  if (!forceRefresh) {
    const cached = await aiCacheModel.getCache(roomId, "prediction");
    if (cached) {
      logger.info(`[AI] Prediction cache hit (stream) — room ${roomId}`);
      yield { type: "done", result: cached, cached: true };
      return;
    }
  }

  const [history, currentUsage, roomPrice, tariff] = await Promise.all([
    aiModel.getUsageHistory(roomId, 6),
    aiModel.getCurrentMonthUsage(roomId),
    aiModel.getRoomPrice(roomId),
    feeModel.getfreequota(),
  ]);

  if (!roomPrice) throw httpError("Room not found", 404);

  const waterM3 = toNumber3((currentUsage.find((c) => c.type === "water")?.used_so_far ?? 0) / 1000);
  const elecKwh = toNumber3(currentUsage.find((c) => c.type === "electric")?.used_so_far ?? 0);
  const rent = toNumber(roomPrice.price_monthly);
  const waterCost = Math.max(0, waterM3 - toNumber(tariff.waterQuota)) * toNumber(tariff.waterRate);
  const elecCost = Math.max(0, elecKwh - toNumber(tariff.electricQuota)) * toNumber(tariff.electricRate);
  const billingEstimate = {
    rent,
    waterCost: Math.round(waterCost),
    elecCost: Math.round(elecCost),
    estimatedTotal: Math.round(rent + waterCost + elecCost),
  };

  const daysInfo = getDaysInfo();
  const prompt = buildPredictionPrompt({ roomId, history, currentUsage, daysInfo, billingEstimate });

  logger.info(`[AI] Streaming prediction — room ${roomId}`);
  for await (const event of streamGemini(prompt, predictionSchema)) {
    if (event.type === "chunk") {
      yield event;
    } else if (event.type === "done") {
      const result = { room_id: Number(roomId), days_info: daysInfo, prediction: event.parsed };
      await aiCacheModel.setCache(roomId, "prediction", result, PREDICTION_TTL_HOURS);
      yield { type: "done", result };
    }
  }
}

module.exports = {
  generateRoomInsight,
  generateRoomPrediction,
  streamRoomInsight,
  streamRoomPrediction,
};
