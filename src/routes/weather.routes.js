const express = require("express");
const router = express.Router();
const weatherController = require("../controllers/weather.controller");
const auth = require("../middlewares/auth.middleware");

router.get("/current", auth, weatherController.getCurrentWeather);

module.exports = router;
