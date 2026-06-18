// api/admin.js
// ============================================================
// All admin routes in a single serverless function.
// Every request is re-verified against the DB via adminGuard.
//
// Actions:
//   GET  stats           — platform statistics
//   GET  users           — paginated/searchable user list
//   POST moderate-user   — ban/unban/suspend/set-role
//   GET  reports         — list user-submitted reports
//   PATCH reports        — resolve/dismiss a report
//   GET  legal-requests  — list legal requests (owner only)
//   POST legal-requests  — log a new legal request (owner only)
//   PATCH legal-requests — update status (owner only)
//   GET  security-logs   — view security event log
// ============================================================

const { sql } = require('../lib/db');
const { requireAdmin, isOwner } = require('../lib/adminGuard');
const { logSecurityEvent } = require('../lib/security');
const { OWNER_EMAIL } = require('../lib/auth');
const { handlePreflight, ok, fail } = require('../lib/respond');

module.exports = async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  const admin = await requireAdmin(req);
  if (!admin) return fail(res, 'Forbidden.', 403);
  const action = req.query.action;

  switch (action) {
    case 'stats':           return stats(admin, req, res);
    case 'users':           return users(admin, req, res);
    case 'moderate-user':   return moderateUser(admin, req, res);
    case 'reports':         return reports(admin, req, res);
    case 'legal-requests':  return legalRequests(admin, req, res);
    case 'security-logs':   return securityLogs(admin, req, res);
    default: return fail(res, 'Unknown action.', 400);
  }
};

// ---------- stats ----------
async function stats(admin, req, res) {
  if (req.method !== 'GET') return fail(res, 'Method not allowed', 405);
  try {
    const [[{ count: totalUsers }], [{ count: onlineUsers }], [{ count: bannedUsers }],
           [{ count: suspendedUsers }], [{ count: totalMessages }], [{ count: messagesToday }],
           [{ count: openReports }], [{ count: newUsersToday }], [{ count: newUsersWeek }]] = await Promise.all([
      sql`SELECT COUNT(*) FROM users`,
      sql`SELECT COUNT(*) FROM users WHERE is_online = TRUE`,
      sql`SELECT COUNT(*) FROM users WHERE is_banned = TRUE`,
      sql`SELECT COUNT(*) FROM users WHERE is_suspended = TRUE`,
      sql`SELECT COUNT(*) FROM messages`,
      sql`SELECT COUNT(*) FROM messages WHERE created_at >= CURRENT_DATE`,
      sql`SELECT COUNT(*) FROM reports WHERE status = 'open'`,
      sql`SELECT COUNT(*) FROM users WHERE created_at >= CURRENT_DATE`,
      sql`SELECT COUNT(*) FROM users WHERE created_at >= NOW() - INTERVAL '7 days'`,
    ]);
    const securityEvents24h = await sql`SELECT event_type, COUNT(*) as count FROM security_logs WHERE created_at >= NOW() - INTERVAL '24 hours' GROUP BY event_type ORDER BY count DESC`;
    return ok(res, { stats: { totalUsers: Number(totalUsers), onlineUsers: Number(onlineUsers), bannedUsers: Number(bannedUsers), suspendedUsers: Number(suspendedUsers), totalMessages: Number(totalMessages), messagesToday: Number(messagesToday), openReports: Number(openReports), newUsersToday: Number(newUsersToday), newUsersWeek: Number(newUsersWeek), securityEvents24h: securityEvents24h.map((r) => ({ type: r.event_type, count: Number(r.count) })) } });
  } catch (err) { console.error('[admin:stats]', err); return fail(res, 'Something went wrong.', 500); }
}

// ---------- users ----------
async function users(admin, req, res) {
  if (req.method !== 'GET') return fail(res, 'Method not allowed', 405);
  try {
    const { q = '', page = 1, limit = 25 } = req.query;
    const offset = (Math.max(Number(page), 1) - 1) * 25;
    const rows = q
      ? await sql`SELECT id, username, email, role, is_verified, is_banned, is_suspended, suspended_until, ban_reason, is_online, last_seen, created_at, share_location, last_location FROM users WHERE username ILIKE ${'%' + q + '%'} OR email ILIKE ${'%' + q + '%'} ORDER BY created_at DESC LIMIT 25 OFFSET ${offset}`
      : await sql`SELECT id, username, email, role, is_verified, is_banned, is_suspended, suspended_until, ban_reason, is_online, last_seen, created_at, share_location, last_location FROM users ORDER BY created_at DESC LIMIT 25 OFFSET ${offset}`;
    return ok(res, { users: rows.map((u) => ({ id: u.id, username: u.username, email: u.email, role: u.role, isVerified: u.is_verified, isBanned: u.is_banned, isSuspended: u.is_suspended, suspendedUntil: u.suspended_until, banReason: u.ban_reason, isOnline: u.is_online, lastSeen: u.last_seen, createdAt: u.created_at, location: u.share_location ? u.last_location : null })) });
  } catch (err) { return fail(res, 'Something went wrong.', 500); }
}

// ---------- moderate-user ----------
async function moderateUser(admin, req, res) {
  if (req.method !== 'POST') return fail(res, 'Method not allowed', 405);
  try {
    const { userId, action, reason = '', suspendUntil, newRole } = req.body || {};
    if (!userId || !action) return fail(res, 'userId and action are required.');
    const [target] = await sql`SELECT id, email, role FROM users WHERE id = ${userId}`;
    if (!target) return fail(res, 'User not found.', 404);
    if (target.email.toLowerCase() === OWNER_EMAIL) return fail(res, 'The founder account cannot be modified.', 403);
    switch (action) {
      case 'ban':       await sql`UPDATE users SET is_banned = TRUE, ban_reason = ${reason}, updated_at = NOW() WHERE id = ${userId}`; break;
      case 'unban':     await sql`UPDATE users SET is_banned = FALSE, ban_reason = NULL, updated_at = NOW() WHERE id = ${userId}`; break;
      case 'suspend': { const until = suspendUntil ? new Date(suspendUntil) : new Date(Date.now() + 86400000); await sql`UPDATE users SET is_suspended = TRUE, suspended_until = ${until.toISOString()}, ban_reason = ${reason}, updated_at = NOW() WHERE id = ${userId}`; break; }
      case 'unsuspend': await sql`UPDATE users SET is_suspended = FALSE, suspended_until = NULL, updated_at = NOW() WHERE id = ${userId}`; break;
      case 'set_role':
        if (!isOwner(admin)) return fail(res, 'Only the owner can change admin roles.', 403);
        if (!['user', 'admin'].includes(newRole)) return fail(res, 'Invalid role.');
        await sql`UPDATE users SET role = ${newRole}, updated_at = NOW() WHERE id = ${userId}`; break;
      default: return fail(res, 'Unknown action.');
    }
    await logSecurityEvent('admin_action', { userId: admin.id, metadata: { action, targetUserId: userId } });
    return ok(res, { message: `Action "${action}" applied.` });
  } catch (err) { return fail(res, 'Something went wrong.', 500); }
}

// ---------- reports ----------
async function reports(admin, req, res) {
  if (req.method === 'GET') {
    try {
      const { status = 'open' } = req.query;
      const rows = status === 'all'
        ? await sql`SELECT r.*, reporter.username AS reporter_username, reported.username AS reported_username, reported.email AS reported_email FROM reports r JOIN users reporter ON reporter.id = r.reporter_id JOIN users reported ON reported.id = r.reported_user_id ORDER BY r.created_at DESC LIMIT 100`
        : await sql`SELECT r.*, reporter.username AS reporter_username, reported.username AS reported_username, reported.email AS reported_email FROM reports r JOIN users reporter ON reporter.id = r.reporter_id JOIN users reported ON reported.id = r.reported_user_id WHERE r.status = ${status} ORDER BY r.created_at DESC LIMIT 100`;
      return ok(res, { reports: rows.map((r) => ({ id: r.id, reason: r.reason, details: r.details, messageSnapshot: r.message_snapshot, status: r.status, adminNotes: r.admin_notes, reporter: { id: r.reporter_id, username: r.reporter_username }, reportedUser: { id: r.reported_user_id, username: r.reported_username, email: r.reported_email }, createdAt: r.created_at })) });
    } catch (err) { return fail(res, 'Something went wrong.', 500); }
  }
  if (req.method === 'PATCH') {
    try {
      const { reportId, status, adminNotes } = req.body || {};
      if (!reportId || !status) return fail(res, 'reportId and status are required.');
      if (!['open','reviewing','resolved','dismissed'].includes(status)) return fail(res, 'Invalid status.');
      const resolvedAt = ['resolved','dismissed'].includes(status) ? new Date().toISOString() : null;
      await sql`UPDATE reports SET status = ${status}, admin_notes = COALESCE(${adminNotes}, admin_notes), resolved_at = ${resolvedAt} WHERE id = ${reportId}`;
      await logSecurityEvent('admin_action', { userId: admin.id, metadata: { action: 'update_report', reportId, status } });
      return ok(res, { message: 'Report updated.' });
    } catch (err) { return fail(res, 'Something went wrong.', 500); }
  }
  return fail(res, 'Method not allowed', 405);
}

// ---------- legal-requests (owner only) ----------
async function legalRequests(admin, req, res) {
  if (!isOwner(admin)) return fail(res, 'This area is restricted to the platform owner.', 403);
  if (req.method === 'GET') {
    try {
      const rows = await sql`SELECT lr.*, u.username AS target_username FROM legal_requests lr LEFT JOIN users u ON u.id = lr.target_user_id ORDER BY lr.created_at DESC`;
      return ok(res, { requests: rows });
    } catch (err) { return fail(res, 'Something went wrong.', 500); }
  }
  if (req.method === 'POST') {
    try {
      const { requestedBy, caseReference, legalBasis, targetUserId, scope, documentUrl } = req.body || {};
      if (!requestedBy || !caseReference || !legalBasis || !scope) return fail(res, 'requestedBy, caseReference, legalBasis, and scope are required.');
      const [created] = await sql`INSERT INTO legal_requests (requested_by, case_reference, legal_basis, target_user_id, scope, document_url) VALUES (${requestedBy}, ${caseReference}, ${legalBasis}, ${targetUserId || null}, ${scope}, ${documentUrl || null}) RETURNING id`;
      await logSecurityEvent('admin_action', { userId: admin.id, metadata: { action: 'log_legal_request', caseReference } });
      return ok(res, { message: 'Legal request logged.', requestId: created.id }, 201);
    } catch (err) { return fail(res, 'Something went wrong.', 500); }
  }
  if (req.method === 'PATCH') {
    try {
      const { requestId, status, notes } = req.body || {};
      if (!requestId || !status) return fail(res, 'requestId and status are required.');
      if (!['pending','approved','denied','fulfilled'].includes(status)) return fail(res, 'Invalid status.');
      const resolvedAt = ['fulfilled','denied'].includes(status) ? new Date().toISOString() : null;
      await sql`UPDATE legal_requests SET status = ${status}, handled_by = ${admin.id}, notes = COALESCE(${notes}, notes), resolved_at = ${resolvedAt} WHERE id = ${requestId}`;
      return ok(res, { message: 'Legal request updated.' });
    } catch (err) { return fail(res, 'Something went wrong.', 500); }
  }
  return fail(res, 'Method not allowed', 405);
}

// ---------- security-logs ----------
async function securityLogs(admin, req, res) {
  if (req.method !== 'GET') return fail(res, 'Method not allowed', 405);
  try {
    const { type, limit = 100 } = req.query;
    const cappedLimit = Math.min(Number(limit) || 100, 500);
    const rows = type
      ? await sql`SELECT sl.*, u.username FROM security_logs sl LEFT JOIN users u ON u.id = sl.user_id WHERE sl.event_type = ${type} ORDER BY sl.created_at DESC LIMIT ${cappedLimit}`
      : await sql`SELECT sl.*, u.username FROM security_logs sl LEFT JOIN users u ON u.id = sl.user_id ORDER BY sl.created_at DESC LIMIT ${cappedLimit}`;
    return ok(res, { logs: rows.map((r) => ({ id: r.id, eventType: r.event_type, userId: r.user_id, username: r.username, ipAddress: r.ip_address, metadata: r.metadata, createdAt: r.created_at })) });
  } catch (err) { return fail(res, 'Something went wrong.', 500); }
}
