const dotenv = require("dotenv");
dotenv.config();

async function fetchCurrentWeather() {
  const apiKey = process.env.WEATHER_API_KEY;

  if (!apiKey) {
    throw new Error("WEATHER_API_KEY belum diset");
  }

  const response = await fetch(
    `https://api.openweathermap.org/data/2.5/weather?appid=${apiKey}&units=metric&lang=id&q=Denpasar`,
  );

  const data = await response.json();

  if (!response.ok) {
    const message = data?.message || "Gagal mengambil data cuaca";
    const err = new Error(message);
    err.statusCode = response.status;
    throw err;
  }

  return data;
}

module.exports = { fetchCurrentWeather };
