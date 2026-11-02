function requireRole(allowedRoles = []) {
  return (req, res, next) => {
    try {
      if (!req.user || !req.user.role) {
        const err = new Error("Unauthorized");
        err.statusCode = 401;
        throw err;
      }

      if (!Array.isArray(allowedRoles) || allowedRoles.length === 0) {
        return next();
      }

      if (!allowedRoles.includes(req.user.role)) {
        const err = new Error("Forbidden");
        err.statusCode = 403;
        throw err;
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { requireRole };
