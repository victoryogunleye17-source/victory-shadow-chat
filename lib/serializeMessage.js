// lib/serializeMessage.js
// ============================================================
// Shared shape for sending a DB message row to the client.
// Used by send/edit/delete/list endpoints to keep the JSON shape consistent.
// ============================================================

function serializeMessage(m) {
  return {
    id: m.id,
    conversationId: m.conversation_id,
    senderId: m.sender_id,
    content: m.is_deleted ? null : m.content,
    attachmentUrl: m.is_deleted ? null : m.attachment_url,
    attachmentType: m.is_deleted ? null : m.attachment_type,
    attachmentName: m.is_deleted ? null : m.attachment_name,
    replyToId: m.reply_to_id || null,
    // Populated only when the row was fetched with a join to its reply target
    // (see lib/db query in api/chat.js). Null otherwise — frontend treats
    // missing replyPreview the same as no reply.
    replyPreview: m.reply_sender_username
      ? {
          id: m.reply_to_id,
          senderUsername: m.reply_sender_username,
          content: m.reply_is_deleted ? null : m.reply_content,
          attachmentType: m.reply_is_deleted ? null : m.reply_attachment_type,
          isDeleted: m.reply_is_deleted,
        }
      : null,
    reactions: m.reactions || {},
    isEdited: m.is_edited,
    isDeleted: m.is_deleted,
    deliveredAt: m.delivered_at,
    readAt: m.read_at,
    createdAt: m.created_at,
  };
}

module.exports = { serializeMessage };
