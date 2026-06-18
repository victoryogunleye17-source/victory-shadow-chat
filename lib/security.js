// lib/security.js
// ============================================================
// Security event logging + lightweight suspicious-pattern detection.
//
// IMPORTANT (by design): this module does NOT give admins blanket
// access to read users' private messages. It only:
//  (1) logs abnormal system events (failed logins, rate-limit hits)
//  (2) flags messages matching high-risk patterns for the SENDER to
//      be notified and for the message to become eligible for the
//      user-report queue — it does not push message content into
//      any admin-readable feed by itself.
// Actual sensitive-content review only happens via user reports
// (reports table) or a documented legal request (legal_requests table).
// ============================================================

const { sql } = require('./db');

async function logSecurityEvent(eventType, { userId = null, ip = null, metadata = {} } = {}) {
  try {
    await sql`
      INSERT INTO security_logs (event_type, user_id, ip_address, metadata)
      VALUES (${eventType}, ${userId}, ${ip}, ${JSON.stringify(metadata)})
    `;
  } catch (err) {
    console.error('[security] failed to log event:', err.message);
  }
}

// Lightweight heuristic flags — NOT a substitute for real moderation tooling,
// just a basic first line of automated detection for obvious spam/abuse patterns.
const SPAM_PATTERNS = [
  /\b(http|https):\/\/\S+.*\b(http|https):\/\/\S+/i, // multiple links in one message
  /(.)\1{12,}/, // 13+ repeated identical characters
];

function isLikelySpam(text) {
  if (!text) return false;
  return SPAM_PATTERNS.some((re) => re.test(text));
}

module.exports = { logSecurityEvent, isLikelySpam };
