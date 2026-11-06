// Express and Engine.IO have separate CORS handling. Keep their policy identical.
const configured = process.env.CORS_ALLOWED_ORIGINS;
const defaults =
  process.env.NODE_ENV === "production"
    ? []
    : ["http://localhost:3000", "http://127.0.0.1:3000"];
const origins = new Set(
  (configured === undefined ? defaults : configured.split(","))
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => {
      const url = new URL(value);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.origin !== value ||
        url.username ||
        url.password
      ) {
        throw new Error(
          "CORS_ALLOWED_ORIGINS must contain exact HTTP(S) browser origins without paths",
        );
      }
      return url.origin;
    }),
);

function allowsOrigin(origin) {
  return origin === undefined || origins.has(origin);
}

const corsOptions = {
  origin: (origin, callback) => callback(null, allowsOrigin(origin)),
  credentials: false, // JWT is sent explicitly; cross-origin cookies are not used.
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "ngrok-skip-browser-warning",
  ],
};

const socketPath = process.env.SOCKET_IO_PATH || "/socket.io";
if (!/^\/[a-zA-Z0-9/_.-]+$/.test(socketPath)) {
  throw new Error("Invalid SOCKET_IO_PATH");
}
module.exports = { allowsOrigin, corsOptions, socketPath };
