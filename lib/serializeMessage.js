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
    reactions: m.reactions || {},
    isEdited: m.is_edited,
    isDeleted: m.is_deleted,
    deliveredAt: m.delivered_at,
    readAt: m.read_at,
    createdAt: m.created_at,
  };
}

module.exports = { serializeMessage };
