const db = require("../config/db");

async function iotAuth(req, res, next) {
  try {
    const deviceUid = req.headers["x-device-uid"];
    if (!deviceUid) {
      const err = new Error("Missing device uid");
      err.statusCode = 401;
      throw err;
    }

    const [rows] = await db.query(
      `
      SELECT id, room_id, type, unit, is_active
      FROM meters
      WHERE device_uid = ?
      LIMIT 1
      `,
      [deviceUid],
    );

    if (!rows[0]) {
      const err = new Error("Device not registered");
      err.statusCode = 401;
      throw err;
    }

    if (!rows[0].is_active) {
      const err = new Error("Device inactive");
      err.statusCode = 403;
      throw err;
    }

    req.meter = rows[0];
    req.device_uid = deviceUid;

    next();
  } catch (err) {
    next(err);
  }
}

module.exports = iotAuth;
