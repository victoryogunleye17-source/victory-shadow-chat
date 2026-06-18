// lib/conversationGuard.js
// ============================================================
// Shared helper: confirms a user is a participant in a conversation
// before allowing read/write access to its messages.
// ============================================================

const { sql } = require('./db');

/**
 * Returns the conversation row if the user is a participant, else null.
 */
async function assertParticipant(conversationId, userId) {
  const [conv] = await sql`
    SELECT id, user_a_id, user_b_id FROM conversations WHERE id = ${conversationId}
  `;
  if (!conv) return null;
  if (conv.user_a_id !== userId && conv.user_b_id !== userId) return null;
  return conv;
}

function otherParticipant(conv, userId) {
  return conv.user_a_id === userId ? conv.user_b_id : conv.user_a_id;
}

module.exports = { assertParticipant, otherParticipant };
