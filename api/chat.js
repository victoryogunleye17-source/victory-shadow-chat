// api/chat.js
// ============================================================
// All real-time chat routes in a single serverless function.
// Route is determined by ?action= query parameter.
//
// Actions:
//   GET    conversations        — list user's conversations
//   POST   conversations        — get-or-create a conversation
//   GET    messages             — paginated message history
//   POST   messages             — send a message
//   PATCH  message-actions      — edit a message
//   DELETE message-actions      — delete a message
//   POST   reactions            — toggle emoji reaction
//   POST   typing               — broadcast typing indicator
//   GET    search-users         — search users by username
//   POST   block                — block a user
//   DELETE block                — unblock a user
//   GET    block                — list blocked users
//   POST   heartbeat            — keep online status alive
//   POST   pusher-auth          — authorize Pusher private channels
// ============================================================

const { sql } = require('../lib/db');
const { getAuthUser } = require('../lib/auth');
const { assertParticipant, otherParticipant } = require('../lib/conversationGuard');
const { triggerEvent, conversationChannel, userChannel, authorizeChannel } = require('../lib/pusher');
const { checkRateLimit, getClientIp } = require('../lib/rateLimit');
const { isLikelySpam, logSecurityEvent } = require('../lib/security');
const { serializeMessage } = require('../lib/serializeMessage');
const { handlePreflight, ok, fail } = require('../lib/respond');

module.exports = async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  const auth = getAuthUser(req);
  if (!auth) return fail(res, 'Not authenticated.', 401);
  const action = req.query.action;

  switch (action) {
    case 'conversations':   return conversations(auth, req, res);
    case 'messages':        return messages(auth, req, res);
    case 'message-actions': return messageActions(auth, req, res);
    case 'reactions':       return reactions(auth, req, res);
    case 'typing':          return typing(auth, req, res);
    case 'search-users':    return searchUsers(auth, req, res);
    case 'block':           return block(auth, req, res);
    case 'heartbeat':       return heartbeat(auth, req, res);
    case 'pusher-auth':     return pusherAuth(auth, req, res);
    default: return fail(res, 'Unknown action.', 400);
  }
};

// ---------- conversations ----------
async function conversations(auth, req, res) {
  if (req.method === 'GET') {
    try {
      const rows = await sql`
        SELECT c.id, c.last_message_at,
          CASE WHEN c.user_a_id = ${auth.sub} THEN c.user_b_id ELSE c.user_a_id END AS other_user_id,
          u.username AS other_username, u.avatar_url AS other_avatar,
          u.is_online AS other_online, u.last_seen AS other_last_seen,
          lm.content AS lm_content, lm.attachment_type AS lm_attachment_type,
          lm.sender_id AS lm_sender_id, lm.is_deleted AS lm_deleted, lm.created_at AS lm_created_at,
          (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.sender_id != ${auth.sub} AND m.read_at IS NULL AND m.is_deleted = FALSE) AS unread_count
        FROM conversations c
        JOIN users u ON u.id = CASE WHEN c.user_a_id = ${auth.sub} THEN c.user_b_id ELSE c.user_a_id END
        LEFT JOIN LATERAL (SELECT * FROM messages m2 WHERE m2.conversation_id = c.id ORDER BY m2.created_at DESC LIMIT 1) lm ON true
        WHERE c.user_a_id = ${auth.sub} OR c.user_b_id = ${auth.sub}
        ORDER BY c.last_message_at DESC NULLS LAST
      `;
      return ok(res, { conversations: rows.map((r) => ({
        id: r.id,
        otherUser: { id: r.other_user_id, username: r.other_username, avatarUrl: r.other_avatar, isOnline: r.other_online, lastSeen: r.other_last_seen },
        lastMessage: r.lm_created_at ? { content: r.lm_deleted ? null : r.lm_content, attachmentType: r.lm_deleted ? null : r.lm_attachment_type, senderId: r.lm_sender_id, isDeleted: r.lm_deleted, createdAt: r.lm_created_at } : null,
        unreadCount: Number(r.unread_count) || 0,
        updatedAt: r.last_message_at,
      })) });
    } catch (err) { console.error('[conversations:get]', err); return fail(res, 'Something went wrong.', 500); }
  }

  if (req.method === 'POST') {
    try {
      const { otherUserId } = req.body || {};
      if (!otherUserId) return fail(res, 'otherUserId is required.');
      if (otherUserId === auth.sub) return fail(res, 'You cannot start a conversation with yourself.');
      const [otherUser] = await sql`SELECT id FROM users WHERE id = ${otherUserId}`;
      if (!otherUser) return fail(res, 'User not found.', 404);
      const blocks = await sql`SELECT 1 FROM blocks WHERE (blocker_id = ${auth.sub} AND blocked_id = ${otherUserId}) OR (blocker_id = ${otherUserId} AND blocked_id = ${auth.sub}) LIMIT 1`;
      if (blocks.length > 0) return fail(res, 'You cannot message this user.', 403);
      const [userA, userB] = [auth.sub, otherUserId].sort();
      const [existing] = await sql`SELECT id FROM conversations WHERE user_a_id = ${userA} AND user_b_id = ${userB}`;
      if (existing) return ok(res, { conversationId: existing.id, created: false });
      const [created] = await sql`INSERT INTO conversations (user_a_id, user_b_id) VALUES (${userA}, ${userB}) RETURNING id`;
      return ok(res, { conversationId: created.id, created: true }, 201);
    } catch (err) { console.error('[conversations:post]', err); return fail(res, 'Something went wrong.', 500); }
  }

  return fail(res, 'Method not allowed', 405);
}

// ---------- messages ----------
async function messages(auth, req, res) {
  if (req.method === 'GET') {
    try {
      const { conversationId, before, limit = 50 } = req.query;
      if (!conversationId) return fail(res, 'conversationId is required.');
      const conv = await assertParticipant(conversationId, auth.sub);
      if (!conv) return fail(res, 'Conversation not found.', 404);
      const cappedLimit = Math.min(Number(limit) || 50, 100);
      const rows = before
        ? await sql`SELECT * FROM messages WHERE conversation_id = ${conversationId} AND created_at < ${before} ORDER BY created_at DESC LIMIT ${cappedLimit}`
        : await sql`SELECT * FROM messages WHERE conversation_id = ${conversationId} ORDER BY created_at DESC LIMIT ${cappedLimit}`;
      const unreadIds = rows.filter((m) => m.sender_id !== auth.sub && !m.read_at).map((m) => m.id);
      if (unreadIds.length > 0) {
        await sql`UPDATE messages SET read_at = NOW() WHERE id = ANY(${unreadIds})`;
        await triggerEvent(conversationChannel(conversationId), 'messages-read', { conversationId, readBy: auth.sub, messageIds: unreadIds });
      }
      return ok(res, { messages: rows.reverse().map(serializeMessage) });
    } catch (err) { console.error('[messages:get]', err); return fail(res, 'Something went wrong.', 500); }
  }

  if (req.method === 'POST') {
    const ip = getClientIp(req);
    const { success } = await checkRateLimit('message', auth.sub);
    if (!success) { await logSecurityEvent('rate_limit_hit', { userId: auth.sub, ip }); return fail(res, 'Sending too fast. Please slow down.', 429); }
    try {
      const { conversationId, content = '', attachmentUrl, attachmentType, attachmentName } = req.body || {};
      if (!conversationId) return fail(res, 'conversationId is required.');
      if (!content.trim() && !attachmentUrl) return fail(res, 'Message cannot be empty.');
      if (content.length > 5000) return fail(res, 'Message too long (max 5000 chars).');
      const conv = await assertParticipant(conversationId, auth.sub);
      if (!conv) return fail(res, 'Conversation not found.', 404);
      const other = otherParticipant(conv, auth.sub);
      const blocked = await sql`SELECT 1 FROM blocks WHERE blocker_id = ${other} AND blocked_id = ${auth.sub} LIMIT 1`;
      if (blocked.length > 0) return fail(res, 'You can no longer message this user.', 403);
      if (isLikelySpam(content)) await logSecurityEvent('suspicious_pattern', { userId: auth.sub, ip, metadata: { conversationId } });
      const [message] = await sql`INSERT INTO messages (conversation_id, sender_id, content, attachment_url, attachment_type, attachment_name, delivered_at) VALUES (${conversationId}, ${auth.sub}, ${content.trim()}, ${attachmentUrl || null}, ${attachmentType || null}, ${attachmentName || null}, NOW()) RETURNING *`;
      await sql`UPDATE conversations SET last_message_at = NOW() WHERE id = ${conversationId}`;
      const payload = serializeMessage(message);
      await triggerEvent(conversationChannel(conversationId), 'new-message', payload);
      await triggerEvent(userChannel(other), 'conversation-updated', { conversationId, lastMessage: payload });
      return ok(res, { message: payload }, 201);
    } catch (err) { console.error('[messages:post]', err); return fail(res, 'Something went wrong.', 500); }
  }

  return fail(res, 'Method not allowed', 405);
}

// ---------- message-actions (edit/delete) ----------
async function messageActions(auth, req, res) {
  if (req.method === 'PATCH') {
    try {
      const { messageId, content } = req.body || {};
      if (!messageId || !content?.trim()) return fail(res, 'messageId and content are required.');
      if (content.length > 5000) return fail(res, 'Message too long.');
      const [existing] = await sql`SELECT * FROM messages WHERE id = ${messageId}`;
      if (!existing) return fail(res, 'Message not found.', 404);
      if (existing.sender_id !== auth.sub) return fail(res, 'You can only edit your own messages.', 403);
      if (existing.is_deleted) return fail(res, 'This message has been deleted.', 400);
      const [updated] = await sql`UPDATE messages SET content = ${content.trim()}, is_edited = TRUE WHERE id = ${messageId} RETURNING *`;
      const payload = serializeMessage(updated);
      await triggerEvent(conversationChannel(existing.conversation_id), 'message-edited', payload);
      return ok(res, { message: payload });
    } catch (err) { return fail(res, 'Something went wrong.', 500); }
  }

  if (req.method === 'DELETE') {
    try {
      const { messageId } = req.body || {};
      if (!messageId) return fail(res, 'messageId is required.');
      const [existing] = await sql`SELECT * FROM messages WHERE id = ${messageId}`;
      if (!existing) return fail(res, 'Message not found.', 404);
      if (existing.sender_id !== auth.sub) return fail(res, 'You can only delete your own messages.', 403);
      await sql`UPDATE messages SET is_deleted = TRUE, content = '', attachment_url = NULL WHERE id = ${messageId}`;
      await triggerEvent(conversationChannel(existing.conversation_id), 'message-deleted', { messageId, conversationId: existing.conversation_id });
      return ok(res, { message: 'Message deleted.' });
    } catch (err) { return fail(res, 'Something went wrong.', 500); }
  }

  return fail(res, 'Method not allowed', 405);
}

// ---------- reactions ----------
async function reactions(auth, req, res) {
  if (req.method !== 'POST') return fail(res, 'Method not allowed', 405);
  const ALLOWED = ['👍','❤️','😂','😮','😢','🙏','🔥','👏'];
  try {
    const { messageId, emoji } = req.body || {};
    if (!messageId || !emoji) return fail(res, 'messageId and emoji are required.');
    if (!ALLOWED.includes(emoji)) return fail(res, 'Unsupported reaction.');
    const [message] = await sql`SELECT * FROM messages WHERE id = ${messageId}`;
    if (!message) return fail(res, 'Message not found.', 404);
    const conv = await assertParticipant(message.conversation_id, auth.sub);
    if (!conv) return fail(res, 'Conversation not found.', 404);
    const reactions = message.reactions || {};
    const current = new Set(reactions[emoji] || []);
    current.has(auth.sub) ? current.delete(auth.sub) : current.add(auth.sub);
    if (current.size === 0) delete reactions[emoji]; else reactions[emoji] = Array.from(current);
    const [updated] = await sql`UPDATE messages SET reactions = ${JSON.stringify(reactions)} WHERE id = ${messageId} RETURNING *`;
    const payload = serializeMessage(updated);
    await triggerEvent(conversationChannel(message.conversation_id), 'message-reaction', payload);
    return ok(res, { message: payload });
  } catch (err) { return fail(res, 'Something went wrong.', 500); }
}

// ---------- typing ----------
async function typing(auth, req, res) {
  if (req.method !== 'POST') return fail(res, 'Method not allowed', 405);
  try {
    const { conversationId, isTyping } = req.body || {};
    if (!conversationId) return fail(res, 'conversationId is required.');
    const conv = await assertParticipant(conversationId, auth.sub);
    if (!conv) return fail(res, 'Conversation not found.', 404);
    await triggerEvent(conversationChannel(conversationId), 'typing', { conversationId, userId: auth.sub, isTyping: !!isTyping });
    return ok(res, { message: 'ok' });
  } catch (err) { return fail(res, 'Something went wrong.', 500); }
}

// ---------- search-users ----------
async function searchUsers(auth, req, res) {
  if (req.method !== 'GET') return fail(res, 'Method not allowed', 405);
  try {
    const q = (req.query.q || '').trim();
    if (q.length < 2) return ok(res, { users: [] });
    const results = await sql`SELECT id, username, avatar_url, status_message, is_online, last_seen FROM users WHERE username ILIKE ${'%' + q + '%'} AND id != ${auth.sub} AND is_banned = FALSE ORDER BY is_online DESC, username ASC LIMIT 20`;
    return ok(res, { users: results.map((u) => ({ id: u.id, username: u.username, avatarUrl: u.avatar_url, statusMessage: u.status_message, isOnline: u.is_online, lastSeen: u.last_seen })) });
  } catch (err) { return fail(res, 'Something went wrong.', 500); }
}

// ---------- block ----------
async function block(auth, req, res) {
  if (req.method === 'GET') {
    try {
      const rows = await sql`SELECT u.id, u.username, u.avatar_url FROM blocks b JOIN users u ON u.id = b.blocked_id WHERE b.blocker_id = ${auth.sub} ORDER BY b.created_at DESC`;
      return ok(res, { blocked: rows.map((r) => ({ id: r.id, username: r.username, avatarUrl: r.avatar_url })) });
    } catch (err) { return fail(res, 'Something went wrong.', 500); }
  }
  if (req.method === 'POST') {
    try {
      const { userId } = req.body || {};
      if (!userId) return fail(res, 'userId is required.');
      if (userId === auth.sub) return fail(res, 'You cannot block yourself.');
      await sql`INSERT INTO blocks (blocker_id, blocked_id) VALUES (${auth.sub}, ${userId}) ON CONFLICT DO NOTHING`;
      return ok(res, { message: 'User blocked.' });
    } catch (err) { return fail(res, 'Something went wrong.', 500); }
  }
  if (req.method === 'DELETE') {
    try {
      const { userId } = req.body || {};
      if (!userId) return fail(res, 'userId is required.');
      await sql`DELETE FROM blocks WHERE blocker_id = ${auth.sub} AND blocked_id = ${userId}`;
      return ok(res, { message: 'User unblocked.' });
    } catch (err) { return fail(res, 'Something went wrong.', 500); }
  }
  return fail(res, 'Method not allowed', 405);
}

// ---------- heartbeat ----------
async function heartbeat(auth, req, res) {
  if (req.method !== 'POST') return fail(res, 'Method not allowed', 405);
  try {
    await sql`UPDATE users SET is_online = TRUE, last_seen = NOW() WHERE id = ${auth.sub}`;
    return ok(res, { message: 'ok' });
  } catch (err) { return fail(res, 'Something went wrong.', 500); }
}

// ---------- pusher-auth ----------
async function pusherAuth(auth, req, res) {
  if (req.method !== 'POST') return fail(res, 'Method not allowed', 405);
  try {
    const { socket_id, channel_name } = req.body || {};
    if (!socket_id || !channel_name) return fail(res, 'Missing socket_id or channel_name.');
    if (channel_name === `private-user-${auth.sub}`) {
      return res.status(200).json(authorizeChannel(socket_id, channel_name, { user_id: auth.sub }));
    }
    const match = channel_name.match(/^private-conversation-(.+)$/);
    if (match) {
      const conv = await assertParticipant(match[1], auth.sub);
      if (!conv) return fail(res, 'Forbidden.', 403);
      return res.status(200).json(authorizeChannel(socket_id, channel_name, { user_id: auth.sub }));
    }
    return fail(res, 'Forbidden.', 403);
  } catch (err) { return fail(res, 'Something went wrong.', 500); }
}
