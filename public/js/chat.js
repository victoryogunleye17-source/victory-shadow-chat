// public/js/chat.js
// ============================================================
// SHADOW CHAT — main chat application logic.
// Handles: auth guard, conversation list, message send/receive,
// real-time via Pusher, typing indicators, reactions, edit/delete,
// attachments, emoji picker, block/report, profile settings.
// ============================================================

(() => {
  // ---------- Auth guard ----------
  const token = ShadowAPI.getToken();
  if (!token) { window.location.href = '/login.html'; return; }

  let me = ShadowAPI.getUser();
  let pusher = null;
  let activeConversationId = null;
  let activeOtherUser = null;
  let conversations = [];
  let messagesCache = {}; // conversationId -> [messages]
  let pendingAttachment = null;
  let typingTimeout = null;
  let subscribedChannels = {};
  let pendingReplyTo = null; // { id, senderUsername, content, attachmentType, isDeleted } or null
  let locationWatchId = null;

  const el = (id) => document.getElementById(id);

  const EMOJI_SET = ['👍','❤️','😂','😮','😢','🙏','🔥','👏','😀','😍','🤔','😎','🎉','👀','💯','😅','🙌','😴','🥳','🤝','✅','❌','⚡'];

  // ---------- Init ----------
  async function init() {
    renderEmojiPicker();
    bindStaticEvents();
    await loadMe();
    await loadConversations();
    initPusher();
    startHeartbeat();
  }

  function startHeartbeat() {
    ShadowAPI.post('/api/chat?action=heartbeat').catch(() => {});
    setInterval(() => { ShadowAPI.post('/api/chat?action=heartbeat').catch(() => {}); }, 30000);
    // Note: we don't try to call logout on tab close — sendBeacon can't carry
    // the Authorization header this API requires. The presence-sweep cron
    // (api/chat/presence-sweep.js) marks the user offline within ~90s instead.
  }

  async function loadMe() {
    try {
      const data = await ShadowAPI.get('/api/auth?action=me');
      me = data.user;
      ShadowAPI.setUser(me);
    } catch (err) {
      window.location.href = '/login.html';
      return;
    }
    el('myUsername').textContent = me.username;
    setAvatar(el('myAvatar'), me);
    if (me.role === 'admin' || me.role === 'owner') {
      el('adminLink').style.display = 'flex';
    }
    el('profileAvatarUrl').value = me.avatarUrl || '';
    el('profileStatus').value = me.statusMessage || '';
    el('profileBio').value = me.bio || '';
    el('profileShareLocation').checked = !!me.shareLocation;
    if (me.shareLocation) startLocationWatch();
  }

  function setAvatar(imgEl, user) {
    if (user.avatarUrl) {
      imgEl.src = user.avatarUrl;
    } else {
      const initial = (user.username || '?')[0].toUpperCase();
      imgEl.src = `data:image/svg+xml,${encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#1a2238"/><text x="50%" y="56%" font-size="42" fill="#5fc1ff" text-anchor="middle" font-family="sans-serif">${initial}</text></svg>`
      )}`;
    }
  }

  // ---------- Conversations ----------
  async function loadConversations() {
    try {
      const data = await ShadowAPI.get('/api/chat?action=conversations');
      conversations = data.conversations;
      renderConversationList();
    } catch (err) {
      console.error('Failed to load conversations', err);
    }
  }

  function renderConversationList(filter = '') {
    const list = el('conversationList');
    const filtered = conversations.filter((c) =>
      c.otherUser.username.toLowerCase().includes(filter.toLowerCase())
    );

    if (filtered.length === 0) {
      list.innerHTML = '<div class="empty-state text-tertiary">No conversations yet. Tap ✚ to start one.</div>';
      return;
    }

    list.innerHTML = '';
    filtered.forEach((c) => {
      const item = document.createElement('div');
      item.className = 'conv-item' + (c.id === activeConversationId ? ' active' : '');
      item.dataset.id = c.id;

      const previewText = c.lastMessage
        ? (c.lastMessage.isDeleted
            ? 'Message deleted'
            : c.lastMessage.attachmentType
              ? (c.lastMessage.attachmentType === 'image' ? '📷 Photo' : '📎 File')
              : (c.lastMessage.content || ''))
        : 'Say hello 👋';

      item.innerHTML = `
        <div class="signal-ring ${c.otherUser.isOnline ? 'online' : ''}">
          <img class="avatar" width="44" height="44" alt="">
        </div>
        <div class="conv-main">
          <div class="conv-name-row">
            <span class="conv-name">${escapeHtml(c.otherUser.username)}</span>
            <span class="conv-time">${c.lastMessage ? formatTime(c.lastMessage.createdAt) : ''}</span>
          </div>
          <div class="conv-preview">${escapeHtml(previewText)}</div>
        </div>
        ${c.unreadCount > 0 ? `<div class="unread-badge">${c.unreadCount}</div>` : ''}
      `;
      setAvatar(item.querySelector('img'), c.otherUser);
      item.addEventListener('click', () => openConversation(c));
      list.appendChild(item);
    });
  }

  async function openConversation(conv) {
    activeConversationId = conv.id;
    activeOtherUser = conv.otherUser;
    cancelReply();

    el('chatEmpty').style.display = 'none';
    el('chatActive').style.display = 'flex';
    el('appShell').classList.add('show-chat');

    el('headerName').textContent = conv.otherUser.username;
    setAvatar(el('headerAvatar'), conv.otherUser);
    updatePresenceUI(conv.otherUser);
    subscribeToConversation(conv.id);

    renderConversationList(el('searchConversations').value);

    await loadMessages(conv.id);
  }

  function updatePresenceUI(user) {
    el('headerRing').classList.toggle('online', !!user.isOnline);
    el('headerStatus').textContent = user.isOnline ? 'Online' : `Last seen ${formatTime(user.lastSeen)}`;
  }

  // ---------- Messages ----------
  async function loadMessages(conversationId) {
    const list = el('messagesList');
    list.innerHTML = '<div class="text-tertiary" style="text-align:center;padding:20px;">Loading…</div>';
    try {
      const data = await ShadowAPI.get(`/api/chat?action=messages&conversationId=${conversationId}`);
      messagesCache[conversationId] = data.messages;
      renderMessages(conversationId);
      const conv = conversations.find((c) => c.id === conversationId);
      if (conv) conv.unreadCount = 0;
      renderConversationList(el('searchConversations').value);
    } catch (err) {
      list.innerHTML = '<div class="text-tertiary" style="text-align:center;padding:20px;">Failed to load messages.</div>';
    }
  }

  function renderMessages(conversationId) {
    if (conversationId !== activeConversationId) return;
    const list = el('messagesList');
    const msgs = messagesCache[conversationId] || [];
    list.innerHTML = '';
    msgs.forEach((m) => list.appendChild(renderMessageRow(m)));
    scrollToBottom();
  }

  function renderMessageRow(m) {
    const row = document.createElement('div');
    row.className = 'msg-row ' + (m.senderId === me.id ? 'mine' : 'theirs');
    row.dataset.id = m.id;

    const replyIcon = document.createElement('div');
    replyIcon.className = 'swipe-reply-icon';
    replyIcon.textContent = '↩';
    row.appendChild(replyIcon);

    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble' + (m.isDeleted ? ' deleted' : '');

    if (m.isDeleted) {
      bubble.textContent = 'This message was deleted';
    } else {
      if (m.replyPreview) {
        const quote = document.createElement('div');
        quote.className = 'reply-quote';
        const quoteSender = document.createElement('div');
        quoteSender.className = 'reply-quote-sender';
        quoteSender.textContent = m.replyPreview.senderUsername === me.username ? 'You' : m.replyPreview.senderUsername;
        const quoteText = document.createElement('div');
        quoteText.className = 'reply-quote-text';
        quoteText.textContent = m.replyPreview.isDeleted
          ? 'Message deleted'
          : (m.replyPreview.attachmentType ? (m.replyPreview.attachmentType === 'image' ? '📷 Photo' : '📎 File') : (m.replyPreview.content || ''));
        quote.appendChild(quoteSender);
        quote.appendChild(quoteText);
        quote.addEventListener('click', () => scrollToMessage(m.replyPreview.id));
        bubble.appendChild(quote);
      }

      if (m.attachmentUrl) {
        if (m.attachmentType === 'image') {
          const img = document.createElement('img');
          img.className = 'msg-image';
          img.src = m.attachmentUrl;
          img.addEventListener('click', () => window.open(m.attachmentUrl, '_blank'));
          bubble.appendChild(img);
        } else {
          const fileDiv = document.createElement('a');
          fileDiv.className = 'msg-file';
          fileDiv.href = m.attachmentUrl;
          fileDiv.target = '_blank';
          fileDiv.style.color = 'inherit';
          fileDiv.style.textDecoration = 'none';
          fileDiv.innerHTML = `📄 <span>${escapeHtml(m.attachmentName || 'File')}</span>`;
          bubble.appendChild(fileDiv);
        }
      }
      if (m.content) {
        const textDiv = document.createElement('div');
        textDiv.textContent = m.content;
        textDiv.style.whiteSpace = 'pre-wrap';
        bubble.appendChild(textDiv);
      }

      const meta = document.createElement('div');
      meta.className = 'msg-meta';
      let metaText = formatTime(m.createdAt);
      if (m.isEdited) metaText += ' · edited';
      if (m.senderId === me.id) {
        metaText += m.readAt ? ' · Read' : m.deliveredAt ? ' · Delivered' : ' · Sent';
      }
      meta.textContent = metaText;
      bubble.appendChild(meta);

      if (m.reactions && Object.keys(m.reactions).length > 0) {
        const reactionsDiv = document.createElement('div');
        reactionsDiv.className = 'msg-reactions';
        Object.entries(m.reactions).forEach(([emoji, userIds]) => {
          const chip = document.createElement('span');
          chip.className = 'reaction-chip' + (userIds.includes(me.id) ? ' mine-reacted' : '');
          chip.innerHTML = `${emoji} ${userIds.length}`;
          chip.addEventListener('click', () => toggleReaction(m.id, emoji));
          reactionsDiv.appendChild(chip);
        });
        bubble.appendChild(reactionsDiv);
      }
    }

    row.appendChild(bubble);

    if (!m.isDeleted) {
      const actions = document.createElement('div');
      actions.className = 'msg-actions';

      const replyBtn = document.createElement('button');
      replyBtn.textContent = '↩';
      replyBtn.title = 'Reply';
      replyBtn.addEventListener('click', () => startReply(m));
      actions.appendChild(replyBtn);

      const reactBtn = document.createElement('button');
      reactBtn.textContent = '😊';
      reactBtn.title = 'React';
      reactBtn.addEventListener('click', (e) => quickReact(e, m.id));
      actions.appendChild(reactBtn);

      if (m.senderId === me.id) {
        const editBtn = document.createElement('button');
        editBtn.textContent = '✎';
        editBtn.title = 'Edit';
        editBtn.addEventListener('click', () => startEditMessage(m));
        actions.appendChild(editBtn);

        const delBtn = document.createElement('button');
        delBtn.textContent = '🗑';
        delBtn.title = 'Delete';
        delBtn.addEventListener('click', () => deleteMessage(m.id));
        actions.appendChild(delBtn);
      }

      row.appendChild(actions);

      // Swipe-to-reply (touch gesture)
      bindSwipeToReply(row, m);
    }

    return row;
  }

  // ---------- Swipe to reply ----------
  function bindSwipeToReply(row, message) {
    let startX = 0;
    let currentX = 0;
    let dragging = false;
    const THRESHOLD = 56; // px of swipe before reply triggers
    const MAX_DRAG = 80;

    row.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      startX = e.touches[0].clientX;
      dragging = true;
      row.classList.add('swiping');
    }, { passive: true });

    row.addEventListener('touchmove', (e) => {
      if (!dragging) return;
      currentX = e.touches[0].clientX - startX;
      // Only allow the natural swipe direction: theirs -> swipe right, mine -> swipe left
      const isMine = row.classList.contains('mine');
      const dx = isMine ? Math.min(0, currentX) : Math.max(0, currentX);
      const clamped = Math.max(-MAX_DRAG, Math.min(MAX_DRAG, dx));
      row.style.transform = `translateX(${clamped}px)`;
      row.classList.toggle('swipe-active', Math.abs(clamped) > THRESHOLD * 0.6);
    }, { passive: true });

    row.addEventListener('touchend', () => {
      if (!dragging) return;
      dragging = false;
      row.classList.remove('swiping');
      row.classList.add('swipe-snap-back');
      const triggered = Math.abs(currentX) > THRESHOLD;
      row.style.transform = 'translateX(0)';
      row.classList.remove('swipe-active');
      if (triggered) startReply(message);
      currentX = 0;
      setTimeout(() => row.classList.remove('swipe-snap-back'), 250);
    });
  }

  function startReply(message) {
    pendingReplyTo = {
      id: message.id,
      senderUsername: message.senderId === me.id ? me.username : (activeOtherUser?.username || 'User'),
      content: message.content,
      attachmentType: message.attachmentType,
      isDeleted: message.isDeleted,
    };
    renderReplyPreviewBar();
    el('messageInput').focus();
  }

  function renderReplyPreviewBar() {
    const bar = el('replyPreviewBar');
    if (!pendingReplyTo) { bar.classList.remove('show'); return; }
    bar.classList.add('show');
    el('replyPreviewSender').textContent = pendingReplyTo.senderUsername === me.username ? 'Replying to yourself' : `Replying to ${pendingReplyTo.senderUsername}`;
    el('replyPreviewText').textContent = pendingReplyTo.isDeleted
      ? 'Message deleted'
      : (pendingReplyTo.attachmentType ? (pendingReplyTo.attachmentType === 'image' ? '📷 Photo' : '📎 File') : (pendingReplyTo.content || ''));
  }

  function cancelReply() {
    pendingReplyTo = null;
    renderReplyPreviewBar();
  }

  function scrollToMessage(messageId) {
    const target = document.querySelector(`.msg-row[data-id="${messageId}"]`);
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.style.transition = 'background-color 0.3s ease';
    target.style.backgroundColor = 'rgba(63,169,255,0.15)';
    setTimeout(() => { target.style.backgroundColor = ''; }, 900);
  }

  function scrollToBottom() {
    const scroll = el('messagesScroll');
    requestAnimationFrame(() => { scroll.scrollTop = scroll.scrollHeight; });
  }

  async function sendMessage() {
    const input = el('messageInput');
    const content = input.value.trim();
    if (!content && !pendingAttachment) return;
    if (!activeConversationId) return;

    const body = { conversationId: activeConversationId, content };
    if (pendingAttachment) {
      body.attachmentUrl = pendingAttachment.url;
      body.attachmentType = pendingAttachment.fileType.startsWith('image/') ? 'image' : 'file';
      body.attachmentName = pendingAttachment.fileName;
    }
    if (pendingReplyTo) {
      body.replyToId = pendingReplyTo.id;
    }

    input.value = '';
    autoGrow(input);
    clearAttachmentPreview();
    cancelReply();
    el('sendBtn').disabled = true;

    try {
      const data = await ShadowAPI.post('/api/chat?action=messages', body);
      addOrUpdateMessage(data.message);
      bumpConversationToTop(activeConversationId, data.message);
    } catch (err) {
      alert(err.message || 'Failed to send message.');
    } finally {
      el('sendBtn').disabled = false;
    }
  }

  function addOrUpdateMessage(message) {
    const convId = message.conversationId;
    if (!messagesCache[convId]) messagesCache[convId] = [];
    const idx = messagesCache[convId].findIndex((m) => m.id === message.id);
    if (idx >= 0) messagesCache[convId][idx] = message;
    else messagesCache[convId].push(message);
    if (convId === activeConversationId) renderMessages(convId);
  }

  function bumpConversationToTop(convId, lastMessage) {
    const conv = conversations.find((c) => c.id === convId);
    if (conv) {
      conv.lastMessage = lastMessage;
      conv.updatedAt = lastMessage.createdAt;
      conversations = [conv, ...conversations.filter((c) => c.id !== convId)];
      renderConversationList(el('searchConversations').value);
    }
  }

  async function startEditMessage(m) {
    const newContent = prompt('Edit message:', m.content);
    if (newContent === null || !newContent.trim() || newContent === m.content) return;
    try {
      const data = await ShadowAPI.patch('/api/chat?action=message-actions', { messageId: m.id, content: newContent.trim() });
      addOrUpdateMessage(data.message);
    } catch (err) {
      alert(err.message || 'Failed to edit message.');
    }
  }

  async function deleteMessage(messageId) {
    if (!confirm('Delete this message?')) return;
    try {
      await ShadowAPI.delete('/api/chat?action=message-actions', { messageId });
      const convId = activeConversationId;
      const msg = messagesCache[convId]?.find((m) => m.id === messageId);
      if (msg) { msg.isDeleted = true; msg.content = null; msg.attachmentUrl = null; }
      renderMessages(convId);
    } catch (err) {
      alert(err.message || 'Failed to delete message.');
    }
  }

  async function toggleReaction(messageId, emoji) {
    try {
      const data = await ShadowAPI.post('/api/chat?action=reactions', { messageId, emoji });
      addOrUpdateMessage(data.message);
    } catch (err) {
      console.error('Reaction failed', err);
    }
  }

  function quickReact(e, messageId) {
    const existing = document.querySelector('.quick-react-popup');
    if (existing) existing.remove();
    const popup = document.createElement('div');
    popup.className = 'quick-react-popup';
    popup.style.cssText = 'position:absolute;display:flex;gap:4px;background:var(--bg-elevated);border:1px solid var(--border-soft);border-radius:12px;padding:6px;z-index:30;box-shadow:0 8px 24px rgba(0,0,0,0.5);';
    ['👍','❤️','😂','😮','😢','🔥'].forEach((emoji) => {
      const span = document.createElement('span');
      span.textContent = emoji;
      span.style.cssText = 'cursor:pointer;font-size:18px;padding:2px;';
      span.addEventListener('click', () => { toggleReaction(messageId, emoji); popup.remove(); });
      popup.appendChild(span);
    });
    document.body.appendChild(popup);
    const rect = e.target.getBoundingClientRect();
    popup.style.top = `${rect.top - 44}px`;
    popup.style.left = `${rect.left - 100}px`;
    setTimeout(() => document.addEventListener('click', () => popup.remove(), { once: true }), 0);
  }

  // ---------- Typing ----------
  function handleTypingInput() {
    if (!activeConversationId) return;
    ShadowAPI.post('/api/chat?action=typing', { conversationId: activeConversationId, isTyping: true }).catch(() => {});
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
      ShadowAPI.post('/api/chat?action=typing', { conversationId: activeConversationId, isTyping: false }).catch(() => {});
    }, 2000);
  }

  function showTypingIndicator(show) {
    el('typingIndicator').style.display = show ? 'flex' : 'none';
    if (show) scrollToBottom();
  }

  // ---------- Real-time (Pusher) ----------
  function initPusher() {
    // Pusher config is injected by /api/config (public, non-secret values only)
    fetch('/api/config').then((r) => r.json()).then((cfg) => {
      if (!cfg.pusherKey) { console.warn('Pusher not configured — real-time disabled.'); return; }

      pusher = new Pusher(cfg.pusherKey, {
        cluster: cfg.pusherCluster,
        authEndpoint: '/api/chat?action=pusher-auth',
        auth: { headers: { Authorization: `Bearer ${ShadowAPI.getToken()}` } },
      });

      const userChannel = pusher.subscribe(`private-user-${me.id}`);
      userChannel.bind('conversation-updated', ({ convers
