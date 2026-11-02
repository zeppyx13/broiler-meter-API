const dotenv = require("dotenv");
dotenv.config();

const app = require("./src/app");
const db = require("./src/config/db");
const { client: mqttClient, setIo } = require("./src/config/mqtt");
const { startScheduler } = require("./src/jobs/scheduler");
const logger = require("./src/config/logger");
const http = require("http");
const { Server } = require("socket.io");

const PORT = process.env.PORT;
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
});

app.set("io", io);
setIo(io);

io.on("connection", (socket) => {
  logger.info(`WebSocket connected: ${socket.id}`);
  socket.on("disconnect", () => {
    logger.info(`WebSocket disconnected: ${socket.id}`);
  });
});

(async () => {
  try {
    await db.query("SELECT 1");
    logger.info("MySQL connected");

    startScheduler();

    server.listen(PORT, () => {
      logger.info(`Server running on http://localhost:${PORT}`);
    });
  } catch (error) {
    logger.error(`Database connection failed: ${error.message}`, error);
    process.exit(1);
  }
})();
