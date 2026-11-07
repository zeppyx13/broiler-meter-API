const { ZodError } = require("zod");
const logger = require("../config/logger");
const recent = new Map();
const safeCodes = new Set([
  "ER_DUP_ENTRY",
  "ER_NO_REFERENCED_ROW_2",
  "ER_ROW_IS_REFERENCED_2",
  "ER_LOCK_DEADLOCK",
  "ER_LOCK_WAIT_TIMEOUT",
  "ER_DATA_TOO_LONG",
  "ER_WARN_DATA_OUT_OF_RANGE",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "PROTOCOL_CONNECTION_LOST",
]);

function logBroilerError(err, statusCode) {
  const code = safeCodes.has(err.code)
    ? err.code
    : err instanceof ZodError
      ? "VALIDATION_ERROR"
      : statusCode >= 500
        ? "INTERNAL_ERROR"
        : "REQUEST_REJECTED";
  const key = `${statusCode}:${code}`;
  const now = Date.now();
  const previous = recent.get(key);
  if (previous && now - previous.at < 30000) {
    previous.suppressed++;
    return;
  }
  if (recent.size >= 64 && !previous) recent.delete(recent.keys().next().value);
  logger[statusCode >= 500 ? "error" : "warn"](
    JSON.stringify({
      event: "broiler_api_error",
      status_code: statusCode,
      error_code: code,
      suppressed_count: previous?.suppressed || 0,
    }),
  );
  recent.set(key, { at: now, suppressed: 0 });
}

function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  let statusCode = err.statusCode || 500;
  let message = err.message || "Internal server error";
  let errors = undefined;

  if (err instanceof ZodError) {
    statusCode = 400;
    message = "Validation error";
    errors = err.issues.map((e) => ({
      path: e.path.join("."),
      message: e.message,
    }));
  }

  if (err.code === "ER_DUP_ENTRY") {
    statusCode = 409;
    message = "Duplicate data";
  }

  if (
    err.code === "ER_ROW_IS_REFERENCED_2" ||
    err.code === "ER_NO_REFERENCED_ROW_2"
  ) {
    statusCode = 409;
    message =
      "Resource is referenced or a required related resource does not exist";
  }

  if (process.env.NODE_ENV !== "test") {
    // mysql2 errors include interpolated SQL; a Copilot insert may contain private conversation text.
    if (process.env.DB_NAME === "coasther_broiler")
      logBroilerError(err, statusCode);
    else console.error(err);
  }

  return res.status(statusCode).json({
    success: false,
    message:
      err.code === "maintenance_migration_required"
        ? "maintenance_migration_required: operator must review backup and additive migration 007 before activation"
        : err.code === "migration_required"
          ? "Phase 5 database migration is required; ask the operator to apply the reviewed migration after backup"
          : statusCode >= 500
            ? "Internal server error"
            : message,
    ...(err.code === "migration_required"
      ? { code: "migration_required" }
      : {}),
    ...(err.code === "maintenance_migration_required"
      ? { code: "maintenance_migration_required" }
      : {}),
    ...(errors ? { errors } : {}),
  });
}

module.exports = errorHandler;
