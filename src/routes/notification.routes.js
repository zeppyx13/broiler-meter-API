const express = require("express");
const router = express.Router();
const auth = require("../middlewares/auth.middleware");
const db = require("../config/db");

router.post("/register-token", auth, async (req, res) => {
  const { fcm_token } = req.body;
  if (!fcm_token)
    return res.status(400).json({ message: "fcm_token required" });

  await db.query("UPDATE users SET fcm_token = ? WHERE id = ?", [
    fcm_token,
    req.user.id,
  ]);
  return res.json({ success: true });
});

module.exports = router;
