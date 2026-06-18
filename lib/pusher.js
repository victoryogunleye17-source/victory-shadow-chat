// lib/pusher.js
// ============================================================
// Pusher Channels — handles real-time event broadcasting.
// Vercel serverless functions can't hold open WebSocket connections,
// so Pusher acts as the always-on real-time layer: our API triggers
// events here, and the browser subscribes directly to Pusher.
// ============================================================

const Pusher = require('pusher');

let pusher = null;
if (process.env.PUSHER_APP_ID) {
  pusher = new Pusher({
    appId: process.env.PUSHER_APP_ID,
    key: process.env.PUSHER_KEY,
    secret: process.env.PUSHER_SECRET,
    cluster: process.env.PUSHER_CLUSTER,
    useTLS: true,
  });
}

/** Channel name for a 1:1 conversation. */
function conversationChannel(conversationId) {
  return `private-conversation-${conversationId}`;
}

/** Channel name for a user's personal notifications (online status, incoming messages list, etc). */
function userChannel(userId) {
  return `private-user-${userId}`;
}

/** Trigger an event on a channel. No-ops with a warning if Pusher isn't configured. */
async function triggerEvent(channel, event, data) {
  if (!pusher) {
    console.warn('[pusher] Not configured — skipping event:', event);
    return;
  }
  try {
    await pusher.trigger(channel, event, data);
  } catch (err) {
    console.error('[pusher] trigger failed:', err.message);
  }
}

/** Authenticate a private channel subscription for a given socket + user. */
function authorizeChannel(socketId, channel, userData) {
  if (!pusher) return null;
  return pusher.authorizeChannel(socketId, channel, userData);
}

module.exports = { pusher, conversationChannel, userChannel, triggerEvent, authorizeChannel };
