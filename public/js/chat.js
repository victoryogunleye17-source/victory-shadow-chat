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

    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble' + (m.isDeleted ? ' deleted' : '');

    if (m.isDeleted) {
      bubble.textContent = 'This message was deleted';
    } else {
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
    }

    return row;
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

    input.value = '';
    autoGrow(input);
    clearAttachmentPreview();
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
      userChannel.bind('conversation-updated', ({ conversationId, lastMessage }) => {
        if (conversationId !== activeConversationId) {
          const conv = conversations.find((c) => c.id === conversationId);
          if (conv) {
            conv.unreadCount = (conv.unreadCount || 0) + 1;
            bumpConversationToTop(conversationId, lastMessage);
          } else {
            loadConversations(); // new conversation we don't know about yet
          }
        }
      });

      conversations.forEach((c) => subscribeToConversation(c.id));
    }).catch((err) => console.warn('Could not load realtime config', err));
  }

  function subscribeToConversation(conversationId) {
    if (!pusher || subscribedChannels[conversationId]) return;
    const channel = pusher.subscribe(`private-conversation-${conversationId}`);
    subscribedChannels[conversationId] = channel;

    channel.bind('new-message', (message) => {
      addOrUpdateMessage(message);
      bumpConversationToTop(message.conversationId, message);
    });
    channel.bind('message-edited', (message) => addOrUpdateMessage(message));
    channel.bind('message-reaction', (message) => addOrUpdateMessage(message));
    channel.bind('message-deleted', ({ messageId, conversationId: cid }) => {
      const msg = messagesCache[cid]?.find((m) => m.id === messageId);
      if (msg) { msg.isDeleted = true; msg.content = null; msg.attachmentUrl = null; }
      if (cid === activeConversationId) renderMessages(cid);
    });
    channel.bind('typing', ({ userId, isTyping }) => {
      if (conversationId === activeConversationId && userId !== me.id) showTypingIndicator(isTyping);
    });
    channel.bind('messages-read', ({ messageIds }) => {
      const msgs = messagesCache[conversationId] || [];
      messageIds.forEach((id) => {
        const m = msgs.find((x) => x.id === id);
        if (m) m.readAt = new Date().toISOString();
      });
      if (conversationId === activeConversationId) renderMessages(conversationId);
    });
  }

  // ---------- New chat / user search ----------
  let searchDebounce = null;
  function bindNewChatModal() {
    el('newChatBtn').addEventListener('click', () => {
      el('newChatModal').style.display = 'flex';
      el('userSearchInput').value = '';
      el('userSearchResults').innerHTML = '';
      el('userSearchInput').focus();
    });
    el('closeNewChatModal').addEventListener('click', () => el('newChatModal').style.display = 'none');
    el('newChatModal').addEventListener('click', (e) => { if (e.target.id === 'newChatModal') e.currentTarget.style.display = 'none'; });

    el('userSearchInput').addEventListener('input', (e) => {
      clearTimeout(searchDebounce);
      const q = e.target.value.trim();
      searchDebounce = setTimeout(() => searchUsers(q), 300);
    });
  }

  async function searchUsers(q) {
    const results = el('userSearchResults');
    if (q.length < 2) { results.innerHTML = ''; return; }
    try {
      const data = await ShadowAPI.get(`/api/chat?action=search-users&q=${encodeURIComponent(q)}`);
      results.innerHTML = '';
      if (data.users.length === 0) {
        results.innerHTML = '<div class="text-tertiary" style="padding:10px;">No users found.</div>';
        return;
      }
      data.users.forEach((u) => {
        const item = document.createElement('div');
        item.className = 'user-result';
        item.innerHTML = `
          <div class="signal-ring ${u.isOnline ? 'online' : ''}"><img class="avatar" width="40" height="40" alt=""></div>
          <div><div style="font-weight:600;font-size:14px;">${escapeHtml(u.username)}</div>
          <div class="text-tertiary" style="font-size:12px;">${escapeHtml(u.statusMessage || (u.isOnline ? 'Online' : 'Offline'))}</div></div>
        `;
        setAvatar(item.querySelector('img'), u);
        item.addEventListener('click', () => startConversationWith(u));
        results.appendChild(item);
      });
    } catch (err) {
      results.innerHTML = '<div class="text-tertiary" style="padding:10px;">Search failed.</div>';
    }
  }

  async function startConversationWith(user) {
    try {
      const data = await ShadowAPI.post('/api/chat?action=conversations', { otherUserId: user.id });
      el('newChatModal').style.display = 'none';
      await loadConversations();
      const conv = conversations.find((c) => c.id === data.conversationId) || {
        id: data.conversationId, otherUser: user, lastMessage: null, unreadCount: 0,
      };
      openConversation(conv);
    } catch (err) {
      alert(err.message || 'Could not start conversation.');
    }
  }

  // ---------- Attachments ----------
  function bindAttachments() {
    el('attachBtn').addEventListener('click', () => el('fileInput').click());
    el('fileInput').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      if (file.size > 15 * 1024 * 1024) { alert('File too large (max 15MB).'); return; }

      const reader = new FileReader();
      reader.onload = async () => {
        const base64Data = reader.result.split(',')[1];
        try {
          el('attachPreview').innerHTML = '<span class="text-tertiary">Uploading…</span>';
          el('attachPreview').style.display = 'flex';
          const isImage = file.type.startsWith('image/');
          const data = await ShadowAPI.post('/api/upload', {
            fileName: file.name,
            fileType: file.type,
            base64Data,
            kind: isImage ? 'chat-image' : 'chat-file',
          });
          pendingAttachment = data;
          renderAttachmentPreview(data, isImage);
        } catch (err) {
          alert(err.message || 'Upload failed.');
          clearAttachmentPreview();
        }
      };
      reader.readAsDataURL(file);
      e.target.value = '';
    });
  }

  function renderAttachmentPreview(data, isImage) {
    const preview = el('attachPreview');
    preview.style.display = 'flex';
    preview.innerHTML = `
      ${isImage ? `<img src="${data.url}" alt="">` : '📄'}
      <span>${escapeHtml(data.fileName)}</span>
      <button id="removeAttachBtn">✕</button>
    `;
    el('removeAttachBtn').addEventListener('click', clearAttachmentPreview);
  }

  function clearAttachmentPreview() {
    pendingAttachment = null;
    el('attachPreview').style.display = 'none';
    el('attachPreview').innerHTML = '';
  }

  // ---------- Emoji picker ----------
  function renderEmojiPicker() {
    const picker = el('emojiPicker');
    EMOJI_SET.forEach((emoji) => {
      const span = document.createElement('span');
      span.textContent = emoji;
      span.addEventListener('click', () => {
        const input = el('messageInput');
        input.value += emoji;
        input.focus();
        picker.classList.remove('show');
      });
      picker.appendChild(span);
    });
  }

  // ---------- Block / Report ----------
  function bindMoreMenu() {
    el('moreBtn').addEventListener('click', (e) => {
      e.stopPropagation();
      el('moreMenu').classList.toggle('show');
    });
    document.addEventListener('click', () => el('moreMenu').classList.remove('show'));

    el('blockBtn').addEventListener('click', async () => {
      if (!activeOtherUser) return;
      if (!confirm(`Block ${activeOtherUser.username}? They won't be able to message you.`)) return;
      try {
        await ShadowAPI.post('/api/chat?action=block', { userId: activeOtherUser.id });
        alert('User blocked.');
      } catch (err) {
        alert(err.message || 'Failed to block user.');
      }
    });

    el('reportBtn').addEventListener('click', () => {
      el('reportModal').style.display = 'flex';
    });
  }

  function bindReportModal() {
    el('closeReportModal').addEventListener('click', () => el('reportModal').style.display = 'none');
    el('submitReportBtn').addEventListener('click', async () => {
      if (!activeOtherUser) return;
      const reason = el('reportReason').value;
      const details = el('reportDetails').value.trim();
      try {
        await ShadowAPI.post('/api/reports', { reportedUserId: activeOtherUser.id, reason, details });
        el('reportAlert').innerHTML = '<div class="alert alert-success">Report submitted. Thank you.</div>';
        setTimeout(() => { el('reportModal').style.display = 'none'; el('reportAlert').innerHTML = ''; el('reportDetails').value = ''; }, 1500);
      } catch (err) {
        el('reportAlert').innerHTML = `<div class="alert alert-error">${err.message}</div>`;
      }
    });
  }

  // ---------- Profile modal ----------
  function bindProfileModal() {
    el('profileBtn').addEventListener('click', () => el('profileModal').style.display = 'flex');
    el('closeProfileModal').addEventListener('click', () => el('profileModal').style.display = 'none');

    el('saveProfileBtn').addEventListener('click', async () => {
      const payload = {
        avatarUrl: el('profileAvatarUrl').value.trim(),
        statusMessage: el('profileStatus').value.trim(),
        bio: el('profileBio').value.trim(),
        shareLocation: el('profileShareLocation').checked,
      };

      if (payload.shareLocation && navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(async (pos) => {
          payload.location = { lat: pos.coords.latitude, lng: pos.coords.longitude };
          await saveProfile(payload);
        }, async () => { await saveProfile(payload); });
      } else {
        await saveProfile(payload);
      }
    });

    el('logoutBtn').addEventListener('click', async () => {
      try { await ShadowAPI.post('/api/auth?action=logout'); } catch {}
      ShadowAPI.clearToken();
      window.location.href = '/login.html';
    });
  }

  async function saveProfile(payload) {
    try {
      await ShadowAPI.put('/api/auth?action=profile', payload);
      el('profileAlert').innerHTML = '<div class="alert alert-success">Profile updated.</div>';
      me = { ...me, ...payload };
      ShadowAPI.setUser(me);
      setAvatar(el('myAvatar'), me);
      setTimeout(() => { el('profileModal').style.display = 'none'; el('profileAlert').innerHTML = ''; }, 1200);
    } catch (err) {
      el('profileAlert').innerHTML = `<div class="alert alert-error">${err.message}</div>`;
    }
  }

  // ---------- Static event bindings ----------
  function bindStaticEvents() {
    el('composerForm').addEventListener('submit', (e) => { e.preventDefault(); sendMessage(); });
    el('messageInput').addEventListener('input', (e) => { autoGrow(e.target); handleTypingInput(); });
    el('messageInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    });
    el('emojiBtn').addEventListener('click', (e) => { e.stopPropagation(); el('emojiPicker').classList.toggle('show'); });
    document.addEventListener('click', (e) => { if (!el('emojiPicker').contains(e.target) && e.target.id !== 'emojiBtn') el('emojiPicker').classList.remove('show'); });

    el('backBtn').addEventListener('click', () => {
      el('appShell').classList.remove('show-chat');
    });

    el('searchConversations').addEventListener('input', (e) => renderConversationList(e.target.value));

    bindNewChatModal();
    bindAttachments();
    bindMoreMenu();
    bindReportModal();
    bindProfileModal();
  }

  function autoGrow(textarea) {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
  }

  function formatTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    if (isToday) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  init();
})();
