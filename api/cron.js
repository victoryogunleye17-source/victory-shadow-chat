// api/cron.js
// ============================================================
// GET /api/cron
// Triggered by Vercel Cron every minute.
// Marks users whose last_seen > 90s ago as offline.
// Protected by CRON_SECRET header.
// ============================================================

const { sql } = require('../lib/db');
const { handlePreflight, ok, fail } = require('../lib/respond');

module.exports = async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  const authHeader = req.headers.authorization;
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return fail(res, 'Forbidden.', 403);
  }
  try {
    const result = await sql`UPDATE users SET is_online = FALSE WHERE is_online = TRUE AND last_seen < NOW() - INTERVAL '90 seconds' RETURNING id`;
    return ok(res, { markedOffline: result.length });
  } catch (err) { return fail(res, 'Something went wrong.', 500); }
};
