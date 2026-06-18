// lib/respond.js
// ============================================================
// Shared helpers for API route responses + basic CORS handling.
// ============================================================

function applyCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.APP_URL || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

/** Call at the top of every handler. Returns true if it handled an OPTIONS preflight (caller should return). */
function handlePreflight(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return true;
  }
  return false;
}

function ok(res, data, status = 200) {
  res.status(status).json({ success: true, ...data });
}

function fail(res, message, status = 400, extra = {}) {
  res.status(status).json({ success: false, error: message, ...extra });
}

module.exports = { applyCors, handlePreflight, ok, fail };
