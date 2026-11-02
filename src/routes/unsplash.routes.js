const express = require("express");
const router = express.Router();
const unsplashController = require("../controllers/unsplash.controller");

router.get("/search", unsplashController.searchPhotos);
router.get("/random", unsplashController.getRandomPhotos);
router.get("/photos/:photoId", unsplashController.getPhotoById);
router.get("/photos/:photoId/download", unsplashController.trackPhotoDownload);
router.get("/background", unsplashController.getBackground);
module.exports = router;
