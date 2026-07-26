// Saves review photos (sent as base64 data URLs) to a local directory backed
// by a Railway volume, so they persist across deploys/restarts.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PHOTOS_DIR = process.env.PHOTOS_DIR || '/data/photos';
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const ALLOWED_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

fs.mkdirSync(PHOTOS_DIR, { recursive: true });

const DATA_URL_PATTERN = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/;

// Returns the saved filename, or null if the input isn't a valid/allowed image.
function saveBase64Photo(dataUrl) {
  if (typeof dataUrl !== 'string') return null;

  const match = dataUrl.match(DATA_URL_PATTERN);
  if (!match) return null;

  const [, mimeType, base64Data] = match;
  const extension = ALLOWED_TYPES[mimeType];
  if (!extension) return null;

  const buffer = Buffer.from(base64Data, 'base64');
  if (buffer.length === 0 || buffer.length > MAX_BYTES) return null;

  const filename = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}.${extension}`;
  fs.writeFileSync(path.join(PHOTOS_DIR, filename), buffer);

  return filename;
}

module.exports = { saveBase64Photo, PHOTOS_DIR };
