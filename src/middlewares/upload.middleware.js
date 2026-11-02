const multer = require("multer");
const sharp = require("sharp");
const path = require("path");
const fs = require("fs");

const UPLOAD_DIR = path.join(process.cwd(), "public/assets/Room");

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

const uploadRoomImage = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    const allowed = [".jpg", ".jpeg", ".png", ".webp"];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(
        new Error("Only image files are allowed (jpg, jpeg, png, webp)"),
        false,
      );
    }
  },
  limits: { fileSize: 10 * 1024 * 1024 },
});

// Middleware kompres & simpan ke disk
async function compressAndSave(req, res, next) {
  if (!req.file) return next();

  try {
    ensureDir(UPLOAD_DIR);

    const filename = `Room_${Date.now()}.jpg`;
    const outputPath = path.join(UPLOAD_DIR, filename);

    await sharp(req.file.buffer)
      .resize(1200, 800, {
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: 90 })
      .toFile(outputPath);
    req.uploadedFile = {
      filename,
      path: outputPath,
      url: `/public/assets/Room/${filename}`,
    };

    next();
  } catch (err) {
    next(new Error("Failed to process image: " + err.message));
  }
}

// Helper untuk hapus file lama dari disk
function deleteOldImage(imagePath) {
  if (!imagePath) return;
  // Hanya hapus file yang ada di folder kita, bukan URL eksternal
  if (!imagePath.startsWith("/public/assets/Room/")) return;

  const filename = path.basename(imagePath);
  const fullPath = path.join(UPLOAD_DIR, filename);

  if (fs.existsSync(fullPath)) {
    fs.unlink(fullPath, (err) => {
      if (err)
        console.error(
          `[upload] Gagal hapus file lama: ${fullPath}`,
          err.message,
        );
    });
  }
}

module.exports = { uploadRoomImage, compressAndSave, deleteOldImage };
