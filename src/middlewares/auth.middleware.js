const jwt = require("jsonwebtoken");
const userModel = require("../models/user.model");
const { fail } = require("../utils/response");

async function authMiddleware(req, res, next) {
  let payload;
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;

    if (!token) {
      return fail(res, "Unauthorized", 401);
    }

    payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ["HS256"] });
    if (!Number.isSafeInteger(Number(payload.id)) || Number(payload.id) < 1) {
      return fail(res, "Invalid token", 401);
    }
  } catch (err) {
    return fail(res, "Invalid token", 401);
  }
  try {
    const user = await userModel.findById(payload.id);
    if (!user || !["admin", "manager", "operator"].includes(user.role)) {
      return fail(res, "Invalid token", 401);
    }
    req.user = user;
    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = authMiddleware;
