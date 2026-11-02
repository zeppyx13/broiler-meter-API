const { ZodError } = require("zod");

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

  if (err.code === "ER_ROW_IS_REFERENCED_2" || err.code === "ER_NO_REFERENCED_ROW_2") {
    statusCode = 409;
    message = "Resource is referenced or a required related resource does not exist";
  }

  if (process.env.NODE_ENV !== "test") {
    console.error(err);
  }

  return res.status(statusCode).json({
    success: false,
    message: statusCode >= 500 ? "Internal server error" : message,
    ...(errors ? { errors } : {}),
  });
}

module.exports = errorHandler;
