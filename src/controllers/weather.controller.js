const { ok, fail } = require("../utils/response");
const weatherService = require("../services/weather.service");

async function getCurrentWeather(req, res) {
  try {
    const result = await weatherService.fetchCurrentWeather();
    return ok(res, result, "OK", 200);
  } catch (err) {
    return fail(res, err.message, err.statusCode || 500);
  }
}

module.exports = { getCurrentWeather };
