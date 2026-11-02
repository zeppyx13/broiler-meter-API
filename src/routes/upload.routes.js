const express = require("express");
const router = express.Router();
const auth = require("../middlewares/auth.middleware");
const { requireRole } = require("../middlewares/role.middleware");
const {
  uploadRoomImage,
  compressAndSave,
  deleteOldImage,
} = require("../middlewares/upload.middleware");

router.post(
  "/room-image",
  auth,
  requireRole(["admin", "manager"]),
  uploadRoomImage.single("image"),
  compressAndSave,
  async (req, res) => {
    try {
      if (!req.uploadedFile) {
        return res.status(400).json({
          success: false,
          message: "No file uploaded",
        });
      }

      // Placeholder untuk logika DB di masa depan
      // await db.updateRoomImage(req.body.roomId, req.uploadedFile.url);

      return res.status(200).json({
        success: true,
        message: "Image uploaded and compressed successfully",
        data: {
          url: req.uploadedFile.url,
          filename: req.uploadedFile.filename,
        },
      });
    } catch (error) {
      if (req.uploadedFile) {
        deleteOldImage(req.uploadedFile.url);
      }
      return res.status(500).json({
        success: false,
        message: "Internal server error: " + error.message,
      });
    }
  },
);

module.exports = router;
