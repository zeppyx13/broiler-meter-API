const logger = require("../config/logger");

function safeRoute(req) {
  // Never log originalUrl: clients may accidentally put secrets or private text in queries/paths.
  // Express owns the matched route template, whose parameters contain names, not user values.
  if (typeof req.route?.path !== "string") return "[unmatched route]";
  const base=typeof req.baseUrl === "string" ? req.baseUrl : "";
  const route=`${base}${req.route.path}`;
  return route.replace(/[\r\n\u0000-\u001f\u007f]/g,"").slice(0,240);
}

function requestLogger(req, res, next) {
  const start = Date.now();

  res.on("finish", () => {
    const duration = Date.now() - start;
    const message = `${req.method} ${safeRoute(req)} ${res.statusCode} ${duration}ms`;

    if (res.statusCode >= 500) {
      logger.error(message);
    } else if (res.statusCode >= 400) {
      logger.warn(message);
    } else {
      logger.info(message);
    }
  });

  next();
}

module.exports = requestLogger;
module.exports.safeRoute = safeRoute;
