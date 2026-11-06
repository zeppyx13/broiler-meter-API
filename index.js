const dotenv = require("dotenv");
dotenv.config();

const app = require("./src/app");
const db = require("./src/config/db");
const logger = require("./src/config/logger");
const http = require("http");
const { Server } = require("socket.io");

const PORT = process.env.PORT;
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
});

app.set("io", io);
if (process.env.DB_NAME === "coasther_broiler") {
  require("./src/services/broilerSocket.service").attach(io);
}

io.on("connection", (socket) => {
  logger.info(`WebSocket connected: ${socket.id}`);
  socket.on("disconnect", () => {
    logger.info(`WebSocket disconnected: ${socket.id}`);
  });
});

(async () => {
  try {
    if (!process.env.JWT_SECRET) throw new Error("JWT_SECRET is required");
    if (process.env.DB_NAME === "coasther_broiler") {
      const result =
        await require("./src/services/schemaCompatibility.service").verify();
      logger.info(
        `Broiler schema verified: ${result.verified_tables} tables, ${result.verified_columns} columns`,
      );
      require("./src/config/mqttBroiler").start({ io });
      logger.info(
        "Broiler monitoring mode: legacy billing and cleanup jobs are disabled",
      );
    } else {
      await db.query("SELECT 1");
      require("./src/config/mqtt").setIo(io);
      require("./src/jobs/scheduler").startScheduler();
    }
    logger.info("MySQL connected");

    server.listen(PORT, () => {
      logger.info(`Server running on http://localhost:${PORT}`);
    });
  } catch (error) {
    logger.error(`Database connection failed: ${error.message}`, error);
    process.exit(1);
  }
})();
