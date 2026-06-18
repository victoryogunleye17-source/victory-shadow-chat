// api/reports.js
// ============================================================
// POST /api/reports
// User-initiated report submission. The only way message content
// becomes visible to admins is when a user explicitly reports it.
// ============================================================

const { sql } = require('../lib/db');
const { getAuthUser } = require('../lib/auth');
const { checkRateLimit, getClientIp } = require('../lib/rateLimit');
const { handlePreflight, ok, fail } = require('../lib/respond');

const VALID_REASONS = ['spam','harassment','threat','csam','impersonation','other'];

module.exports = async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  if (req.method !== 'POST') return fail(res, 'Method not allowed', 405);
  const auth = getAuthUser(req);
  if (!auth) return fail(res, 'Not authenticated.', 401);
  const { success } = await checkRateLimit('general', auth.sub);
  if (!success) return fail(res, 'Too many reports. Please wait.', 429);
  try {
    const { reportedUserId, messageId, reason, details = '' } = req.body || {};
    if (!reportedUserId || !reason) return fail(res, 'reportedUserId and reason are required.');
    if (!VALID_REASONS.includes(reason)) return fail(res, 'Invalid report reason.');
    let messageSnapshot = null;
    if (messageId) {
      const [msg] = await sql`SELECT content, sender_id FROM messages WHERE id = ${messageId}`;
      if (msg && msg.sender_id === reportedUserId) messageSnapshot = msg.content;
    }
    const [report] = await sql`INSERT INTO reports (reporter_id, reported_user_id, message_id, reason, details, message_snapshot) VALUES (${auth.sub}, ${reportedUserId}, ${messageId || null}, ${reason}, ${details}, ${messageSnapshot}) RETURNING id, created_at`;
    return ok(res, { message: 'Report submitted. Our safety team will review it.', reportId: report.id }, 201);
  } catch (err) { console.error('[reports]', err); return fail(res, 'Something went wrong submitting your report.', 500); }
};
