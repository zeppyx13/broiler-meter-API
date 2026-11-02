const { ok, fail } = require("../utils/response");
const unsplashService = require("../services/unsplash.service");

async function searchPhotos(req, res) {
  try {
    const result = await unsplashService.searchPhotos(req.query);
    return ok(res, result, "Unsplash photos fetched");
  } catch (err) {
    return fail(res, err.message, err.statusCode || 500);
  }
}

async function getRandomPhotos(req, res) {
  try {
    const result = await unsplashService.getRandomPhotos(req.query);
    return ok(res, result, "Unsplash random photos fetched");
  } catch (err) {
    return fail(res, err.message, err.statusCode || 500);
  }
}

async function getPhotoById(req, res) {
  try {
    const result = await unsplashService.getPhotoById(req.params.photoId);
    return ok(res, result, "Unsplash photo fetched");
  } catch (err) {
    return fail(res, err.message, err.statusCode || 500);
  }
}

async function trackPhotoDownload(req, res) {
  try {
    const result = await unsplashService.trackPhotoDownload(req.params.photoId);
    return ok(res, result, "Unsplash download tracked");
  } catch (err) {
    return fail(res, err.message, err.statusCode || 500);
  }
}
async function getBackground(req, res) {
  try {
    const result = await unsplashService.backgroundPhoto();
    return ok(res, result, "Background image fetched");
  } catch (err) {
    return fail(res, err.message, err.statusCode || 500);
  }
}
module.exports = {
  searchPhotos,
  getRandomPhotos,
  getPhotoById,
  trackPhotoDownload,
  getBackground,
};
