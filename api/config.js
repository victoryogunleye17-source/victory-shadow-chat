// api/config.js
// ============================================================
// GET /api/config
// Exposes ONLY public, non-secret config values the frontend needs
// (e.g. the Pusher app key, which is meant to be public — auth is
// still enforced server-side via /api/chat/pusher-auth).
// Never put PUSHER_SECRET, JWT_SECRET, DATABASE_URL, etc. here.
// ============================================================

const { handlePreflight, ok } = require('../lib/respond');

module.exports = async function handler(req, res) {
  if (handlePreflight(req, res)) return;

  ok(res, {
    pusherKey: process.env.PUSHER_KEY || null,
    pusherCluster: process.env.PUSHER_CLUSTER || null,
  });
};
