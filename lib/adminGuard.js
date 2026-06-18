// lib/adminGuard.js
// ============================================================
// Admin authorization guard.
//
// IMPORTANT: we deliberately re-check the role against the database
// on every admin request rather than trusting the JWT's role claim.
// JWTs can live up to 7 days — if an account is demoted, banned, or
// the OWNER_EMAIL config changes, the JWT could lag behind reality.
// For a "hidden, highly protected admin dashboard" this re-check is
// the difference between a real guarantee and a stale one.
// ============================================================

const { sql } = require('./db');
const { getAuthUser, isAdminRole } = require('./auth');
const { logSecurityEvent } = require('./security');

/**
 * Returns the current DB user row if they're an active admin/owner, else null.
 * Also logs an event if a non-admin attempts to hit an admin route — that's
 * exactly the kind of abnormal event a "security logs" panel should show.
 */
async function requireAdmin(req) {
  const auth = getAuthUser(req);
  if (!auth) return null;

  const [user] = await sql`
    SELECT id, username, email, role, is_banned, is_suspended FROM users WHERE id = ${auth.sub}
  `;

  if (!user || user.is_banned) return null;
  if (!isAdminRole(user.role)) {
    await logSecurityEvent('unauthorized_admin_attempt', { userId: auth.sub, metadata: { route: req.url } });
    return null;
  }

  return user;
}

/** Owner-only actions (e.g. promoting/demoting admins) require role === 'owner' specifically. */
function isOwner(user) {
  return user && user.role === 'owner';
}

module.exports = { requireAdmin, isOwner };
