// api/upload.js
// ============================================================
// POST /api/upload
// Accepts base64 JSON uploads, stores to Vercel Blob.
// ============================================================

const { put } = require('@vercel/blob');
const { getAuthUser } = require('../lib/auth');
const { checkRateLimit, getClientIp } = require('../lib/rateLimit');
const { handlePreflight, ok, fail } = require('../lib/respond');

const MAX_BYTES = 15 * 1024 * 1024;
const ALLOWED_IMAGE = ['image/jpeg','image/png','image/gif','image/webp'];
const ALLOWED_ALL = [...ALLOWED_IMAGE,'application/pdf','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document','text/plain','application/zip'];

module.exports = async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  if (req.method !== 'POST') return fail(res, 'Method not allowed', 405);
  const auth = getAuthUser(req);
  if (!auth) return fail(res, 'Not authenticated.', 401);
  const { success } = await checkRateLimit('general', auth.sub);
  if (!success) return fail(res, 'Too many uploads. Please wait.', 429);
  try {
    const { fileName, fileType, base64Data, kind = 'chat-file' } = req.body || {};
    if (!fileName || !fileType || !base64Data) return fail(res, 'fileName, fileType, and base64Data are required.');
    const allowList = (kind === 'avatar' || kind === 'chat-image') ? ALLOWED_IMAGE : ALLOWED_ALL;
    if (!allowList.includes(fileType)) return fail(res, `File type ${fileType} is not allowed.`);
    const buffer = Buffer.from(base64Data, 'base64');
    if (buffer.length > MAX_BYTES) return fail(res, 'File too large. Max 15MB.');
    const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const pathPrefix = kind === 'avatar' ? 'avatars' : 'chat-uploads';
    const blob = await put(`${pathPrefix}/${auth.sub}/${Date.now()}-${safeName}`, buffer, { access: 'public', contentType: fileType });
    return ok(res, { url: blob.url, fileName: safeName, fileType, size: buffer.length }, 201);
  } catch (err) { console.error('[upload]', err); return fail(res, 'Something went wrong uploading your file.', 500); }
};
