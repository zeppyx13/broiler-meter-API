const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const path = require("path");
// routes init
const authRoutes = require("./routes/auth.routes");
const userRoutes = require("./routes/user.routes");
const userAdminRoutes = require("./routes/user.admin.routes");
const uploadRoutes = require("./routes/upload.routes");
const isBroiler = process.env.DB_NAME === "coasther_broiler";
// app init
const app = express();
app.set("trust proxy", 1);
// Middleware
const notFound = require("./middlewares/notFound.middleware");
const errorHandler = require("./middlewares/error.middleware");
const requestLogger = require("./middlewares/requestLogger.middleware");
app.use(helmet());
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: [
      "Content-Type",
      "ngrok-skip-browser-warning",
      "Authorization",
    ],
  }),
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(requestLogger);
const {
  generalLimiter,
  authLimiter,
  aiLimiter,
  schedulerLimiter,
  relayLimiter,
  uploadLimiter,
} = require("./middlewares/rateLimit.middleware");

// LIMITER
app.use(generalLimiter);
// Specific limiters
app.use("/api/auth", authLimiter);
app.use(isBroiler ? "/api/ai/copilot" : "/api/ai", aiLimiter);
app.use("/api/scheduler", schedulerLimiter);
app.use("/api/upload", uploadLimiter);
// Serve static files from /public
app.use(
  "/public",
  (req, res, next) => {
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    next();
  },
  express.static(path.join(__dirname, "../public")),
);
// routes
app.get("/", (req, res) => {
  res.status(200).sendFile(path.join(__dirname, "../index.html"));
});
app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/users-admin", userAdminRoutes);
app.use("/api/upload", uploadRoutes);
if (isBroiler) {
  app.use("/api/farms", require("./routes/farm.routes"));
  app.use("/api/coops", require("./routes/coop.routes"));
  app.use("/api/flock-cycles", require("./routes/flockCycle.routes"));
  app.use("/api/dashboard", require("./routes/dashboardContext.routes"));
  app.use("/api/devices", require("./routes/device.routes"));
  app.use("/api/meters", require("./routes/meterBroiler.routes"));
  app.use("/api/dashboard", require("./routes/dashboardMonitoring.routes"));
  const guardRoutes = require("./routes/guard.routes");
  app.use("/api/alert-rules", guardRoutes.rulesRouter);
  app.use("/api/alerts", guardRoutes.alertsRouter);
  app.use("/api/guard", guardRoutes.statusRouter);
  app.use("/api/notifications", require("./routes/notificationBroiler.routes"));
  app.use("/api/relays", require("./routes/relayBroiler.routes"));
  app.use("/api/forecasts", require("./routes/forecast.routes"));
  app.use("/api/eco-recommendations", require("./routes/ecoAdvisor.routes"));
  app.use("/api/ai", require("./routes/copilotBroiler.routes"));
} else {
  // Retain legacy routes without loading their MQTT/payment/AI dependencies in broiler mode.
  app.use("/api/rooms", require("./routes/room.routes"));
  app.use("/api/tenants", require("./routes/tenant.routes"));
  app.use("/api/payments", require("./routes/payment.routes"));
  app.use("/api/iot", require("./routes/iot.routes"));
  app.use("/api/announcements", require("./routes/announcement.routes"));
  app.use("/api/reviews", require("./routes/review.routes"));
  app.use("/api/complaints", require("./routes/complaint.routes"));
  app.use("/api/dashboard", require("./routes/dashboard.routes"));
  app.use("/api/weather", require("./routes/weather.routes"));
  app.use("/api/ai", require("./routes/ai.routes"));
  app.use("/api/unsplash", require("./routes/unsplash.routes"));
  app.use("/api/tariff", require("./routes/tariff.routes"));
  app.use("/api/leases", require("./routes/lease.routes"));
  app.use("/api/invoices", require("./routes/invoice.admin.routes"));
  app.use("/api/facilities", require("./routes/facility.routes"));
  app.use("/api/meters", require("./routes/meter.routes"));
  app.use("/api/payments-admin", require("./routes/payment.admin.routes"));
  app.use("/api/scheduler", require("./routes/scheduler.routes"));
  app.use("/api/notifications", require("./routes/notification.routes"));
}
// 404 handler
app.use(notFound);
app.use(errorHandler);
module.exports = app;
