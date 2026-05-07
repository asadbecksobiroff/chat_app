/* ===== ChatVault — Main Chat Logic ===== */
(function () {
  'use strict';

  // --- Auth Guard ---
  const token = localStorage.getItem('chat_token');
  if (!token) { window.location.href = '/'; return; }

  let currentUser = JSON.parse(localStorage.getItem('chat_user') || '{}');
  let socket = null;
  let activeChatId = null;
  let activeChatUser = null;
  let chats = [];
  let typingTimeout = null;
  let isTyping = false;
  let loadingMore = false;
  let hasMoreMessages = false;
  let oldestMessageId = null;

  // --- DOM Elements ---
  const $ = (id) => document.getElementById(id);
  const chatApp = $('chatApp');
  const myAvatar = $('myAvatar');
  const myDisplayName = $('myDisplayName');
  const chatList = $('chatList');
  const chatListEmpty = $('chatListEmpty');
  const searchInput = $('searchInput');
  const searchResults = $('searchResults');
  const chatEmpty = $('chatEmpty');
  const chatHeader = $('chatHeader');
  const chatAvatar = $('chatAvatar');
  const chatOnlineDot = $('chatOnlineDot');
  const chatName = $('chatName');
  const chatStatus = $('chatStatus');
  const messagesContainer = $('messagesContainer');
  const messageInputBar = $('messageInputBar');
  const messageInput = $('messageInput');
  const sendBtn = $('sendBtn');
  const typingIndicator = $('typingIndicator');
  const typingText = $('typingText');
  const backBtn = $('backBtn');
  const logoutBtn = $('logoutBtn');
  const toastContainer = $('toastContainer');

  // --- Utilities ---
  function showToast(msg, type = 'error') {
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    t.textContent = msg;
    toastContainer.appendChild(t);
    setTimeout(() => t.remove(), 3000);
  }

  async function api(url, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (!(opts.body instanceof FormData)) headers['Content-Type'] = 'application/json';
    const res = await fetch(url, { ...opts, headers });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  }

  function formatTime(dateStr) {
    const d = new Date(dateStr);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  }

  function formatDate(dateStr) {
    const d = new Date(dateStr);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
    const msgDate = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    if (msgDate.getTime() === today.getTime()) return 'Today';
    if (msgDate.getTime() === yesterday.getTime()) return 'Yesterday';
    return d.toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' });
  }

  function formatLastSeen(dateStr) {
    if (!dateStr) return 'offline';
    const d = new Date(dateStr);
    const now = new Date();
    const diff = (now - d) / 1000;
    if (diff < 60) return 'last seen just now';
    if (diff < 3600) return `last seen ${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `last seen ${Math.floor(diff / 3600)}h ago`;
    return `last seen ${d.toLocaleDateString([], { day: '2-digit', month: 'short' })}`;
  }

  function shortPreview(text, max = 35) {
    if (!text) return '';
    return text.length > max ? text.substring(0, max) + '…' : text;
  }

  function sidebarTime(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const msgDate = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    if (msgDate.getTime() === today.getTime()) return formatTime(dateStr);
    const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
    if (msgDate.getTime() === yesterday.getTime()) return 'Yesterday';
    return d.toLocaleDateString([], { day: '2-digit', month: 'short' });
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // --- Init ---
  async function init() {
    try {
      const data = await api('/api/auth/me');
      currentUser = data.user;
      localStorage.setItem('chat_user', JSON.stringify(currentUser));
      myAvatar.src = currentUser.avatar_url;
      myDisplayName.textContent = currentUser.display_name || currentUser.username;
    } catch (err) {
      localStorage.removeItem('chat_token');
      localStorage.removeItem('chat_user');
      window.location.href = '/';
      return;
    }
    connectSocket();
    loadChats();
  }

  // --- Socket.IO ---
  function connectSocket() {
    socket = io({ auth: { token } });

    socket.on('connect', () => console.log('Socket connected'));
    socket.on('connect_error', (err) => {
      console.error('Socket auth error:', err.message);
      if (err.message === 'Invalid token') {
        localStorage.removeItem('chat_token');
        window.location.href = '/';
      }
    });

    socket.on('message:new', (msg) => {
      if (msg.chat_id === activeChatId) {
        appendMessage(msg);
        scrollToBottom();
        // Mark as read
        socket.emit('chat:join', { chatId: activeChatId });
      }
    });

    socket.on('chat:updated', ({ chatId, lastMessage }) => {
      // Update sidebar
      const chatIdx = chats.findIndex(c => c.id === chatId);
      if (chatIdx !== -1) {
        chats[chatIdx].lastMessage = lastMessage;
        if (chatId !== activeChatId && lastMessage.sender_id !== currentUser.id) {
          chats[chatIdx].unreadCount = (chats[chatIdx].unreadCount || 0) + 1;
        }
      }
      renderChatList();
    });

    socket.on('messages:read', ({ chatId, userId, messageIds }) => {
      if (chatId === activeChatId && userId !== currentUser.id) {
        messageIds.forEach(id => {
          const el = document.querySelector(`.message-wrapper[data-id="${id}"] .message-status`);
          if (el) { el.textContent = '✓✓'; el.classList.add('read'); }
        });
      }
    });

    socket.on('typing:start', ({ userId, username }) => {
      if (activeChatUser && userId === activeChatUser.id) {
        typingText.textContent = `${username} is typing…`;
        typingIndicator.classList.add('visible');
        chatStatus.textContent = 'typing…';
        chatStatus.className = 'chat-header-status typing';
      }
    });

    socket.on('typing:stop', ({ userId }) => {
      if (activeChatUser && userId === activeChatUser.id) {
        typingIndicator.classList.remove('visible');
        updateChatHeaderStatus();
      }
    });

    socket.on('user:online', ({ userId }) => {
      // Update sidebar items
      chats.forEach(c => { if (c.otherUser && c.otherUser.id === userId) c.otherUser.is_online = 1; });
      renderChatList();
      if (activeChatUser && activeChatUser.id === userId) {
        activeChatUser.is_online = 1;
        updateChatHeaderStatus();
      }
    });

    socket.on('user:offline', ({ userId, lastSeen }) => {
      chats.forEach(c => {
        if (c.otherUser && c.otherUser.id === userId) {
          c.otherUser.is_online = 0;
          c.otherUser.last_seen = lastSeen;
        }
      });
      renderChatList();
      if (activeChatUser && activeChatUser.id === userId) {
        activeChatUser.is_online = 0;
        activeChatUser.last_seen = lastSeen;
        updateChatHeaderStatus();
      }
    });
  }

  // --- Load Chats ---
  async function loadChats() {
    try {
      const data = await api('/api/chats');
      chats = data.chats;
      renderChatList();
    } catch (err) {
      showToast('Failed to load conversations');
    }
  }

  function renderChatList() {
    // Sort by latest message
    chats.sort((a, b) => {
      const tA = a.lastMessage ? new Date(a.lastMessage.created_at).getTime() : 0;
      const tB = b.lastMessage ? new Date(b.lastMessage.created_at).getTime() : 0;
      return tB - tA;
    });

    // Remove old items (keep empty placeholder)
    chatList.querySelectorAll('.chat-item').forEach(el => el.remove());

    if (chats.length === 0) {
      chatListEmpty.style.display = 'flex';
      return;
    }
    chatListEmpty.style.display = 'none';

    chats.forEach(chat => {
      const u = chat.otherUser;
      if (!u) return;
      const el = document.createElement('div');
      el.className = 'chat-item' + (chat.id === activeChatId ? ' active' : '');
      el.dataset.chatId = chat.id;
      el.innerHTML = `
        <div class="chat-item-avatar">
          <img src="${escapeHtml(u.avatar_url)}" alt="${escapeHtml(u.display_name || u.username)}">
          ${u.is_online ? '<div class="online-dot"></div>' : ''}
        </div>
        <div class="chat-item-info">
          <div class="chat-item-top">
            <span class="chat-item-name">${escapeHtml(u.display_name || u.username)}</span>
            <span class="chat-item-time">${chat.lastMessage ? sidebarTime(chat.lastMessage.created_at) : ''}</span>
          </div>
          <div class="chat-item-bottom">
            <span class="chat-item-preview">${chat.lastMessage ? escapeHtml(shortPreview(chat.lastMessage.content)) : 'No messages yet'}</span>
            ${chat.unreadCount > 0 ? `<span class="chat-item-badge">${chat.unreadCount}</span>` : ''}
          </div>
        </div>`;
      el.addEventListener('click', () => openChat(chat.id, u));
      chatList.appendChild(el);
    });
  }

  // --- Open Chat ---
  async function openChat(chatId, otherUser) {
    if (activeChatId && activeChatId !== chatId) {
      socket.emit('chat:leave', { chatId: activeChatId });
    }

    activeChatId = chatId;
    activeChatUser = otherUser;

    // Mobile: show chat area
    chatApp.classList.add('chat-open');

    // Update header
    chatEmpty.style.display = 'none';
    chatHeader.style.display = 'flex';
    messagesContainer.style.display = 'flex';
    messageInputBar.style.display = 'flex';

    chatAvatar.src = otherUser.avatar_url;
    chatName.textContent = otherUser.display_name || otherUser.username;
    updateChatHeaderStatus();

    // Clear messages
    messagesContainer.innerHTML = '';
    oldestMessageId = null;
    hasMoreMessages = false;

    // Mark active in sidebar
    chatList.querySelectorAll('.chat-item').forEach(el => {
      el.classList.toggle('active', parseInt(el.dataset.chatId) === chatId);
    });

    // Clear unread
    const chatIdx = chats.findIndex(c => c.id === chatId);
    if (chatIdx !== -1) chats[chatIdx].unreadCount = 0;
    renderChatList();

    // Join room & load messages
    socket.emit('chat:join', { chatId });
    await loadMessages(chatId);
    scrollToBottom();
    messageInput.focus();
  }

  function updateChatHeaderStatus() {
    if (!activeChatUser) return;
    if (activeChatUser.is_online) {
      chatStatus.textContent = 'Online';
      chatStatus.className = 'chat-header-status online';
      chatOnlineDot.style.display = 'block';
    } else {
      chatStatus.textContent = formatLastSeen(activeChatUser.last_seen);
      chatStatus.className = 'chat-header-status';
      chatOnlineDot.style.display = 'none';
    }
  }

  // --- Load Messages ---
  async function loadMessages(chatId, before = null) {
    try {
      let url = `/api/chats/${chatId}/messages?limit=50`;
      if (before) url += `&before=${before}`;
      const data = await api(url);
      hasMoreMessages = data.hasMore;

      if (data.messages.length > 0) {
        oldestMessageId = data.messages[0].id;
        if (data.hasMore) showLoadMoreButton();
        renderMessages(data.messages, !!before);
      }
    } catch (err) {
      showToast('Failed to load messages');
    }
  }

  function showLoadMoreButton() {
    // Remove existing
    const existing = messagesContainer.querySelector('.load-more-btn');
    if (existing) existing.remove();
    const btn = document.createElement('button');
    btn.className = 'load-more-btn';
    btn.textContent = 'Load older messages';
    btn.addEventListener('click', async () => {
      if (loadingMore) return;
      loadingMore = true;
      btn.textContent = 'Loading…';
      const scrollH = messagesContainer.scrollHeight;
      await loadMessages(activeChatId, oldestMessageId);
      // Maintain scroll position
      messagesContainer.scrollTop = messagesContainer.scrollHeight - scrollH;
      loadingMore = false;
    });
    messagesContainer.prepend(btn);
  }

  function renderMessages(messages, prepend = false) {
    let lastDate = null;
    const frag = document.createDocumentFragment();

    // If prepending, remove old load-more button
    if (prepend) {
      const btn = messagesContainer.querySelector('.load-more-btn');
      if (btn) btn.remove();
    }

    messages.forEach(msg => {
      const msgDate = formatDate(msg.created_at);
      if (msgDate !== lastDate) {
        lastDate = msgDate;
        const sep = document.createElement('div');
        sep.className = 'date-separator';
        sep.innerHTML = `<span>${msgDate}</span>`;
        frag.appendChild(sep);
      }
      frag.appendChild(createMessageEl(msg));
    });

    if (prepend) {
      if (hasMoreMessages) {
        const btn = document.createElement('button');
        btn.className = 'load-more-btn';
        btn.textContent = 'Load older messages';
        btn.addEventListener('click', async () => {
          if (loadingMore) return;
          loadingMore = true;
          btn.textContent = 'Loading…';
          const scrollH = messagesContainer.scrollHeight;
          await loadMessages(activeChatId, oldestMessageId);
          messagesContainer.scrollTop = messagesContainer.scrollHeight - scrollH;
          loadingMore = false;
        });
        messagesContainer.prepend(btn);
      }
      // Insert after load-more button
      const firstChild = messagesContainer.querySelector('.load-more-btn');
      if (firstChild) {
        firstChild.after(frag);
      } else {
        messagesContainer.prepend(frag);
      }
    } else {
      messagesContainer.appendChild(frag);
    }
  }

  function createMessageEl(msg) {
    const isMine = msg.sender_id === currentUser.id;
    const wrapper = document.createElement('div');
    wrapper.className = `message-wrapper ${isMine ? 'mine' : 'theirs'}`;
    wrapper.dataset.id = msg.id;

    const isRead = msg.readBy && msg.readBy.length > 0 && msg.readBy.some(id => id !== currentUser.id);
    const statusIcon = isMine ? (isRead ? '✓✓' : '✓') : '';
    const statusClass = isRead ? 'read' : '';

    wrapper.innerHTML = `
      ${!isMine ? `<img class="message-avatar" src="${escapeHtml(msg.sender_avatar)}" alt="">` : ''}
      <div class="message-bubble">
        <div class="message-content">${escapeHtml(msg.content)}</div>
        <div class="message-meta">
          <span class="message-time">${formatTime(msg.created_at)}</span>
          ${isMine ? `<span class="message-status ${statusClass}">${statusIcon}</span>` : ''}
        </div>
      </div>`;
    return wrapper;
  }

  function appendMessage(msg) {
    // Check if date separator is needed
    const existingMessages = messagesContainer.querySelectorAll('.message-wrapper');
    let needsDateSep = true;
    if (existingMessages.length > 0) {
      const lastMsg = existingMessages[existingMessages.length - 1];
      // Check if the last date separator matches
      const seps = messagesContainer.querySelectorAll('.date-separator');
      if (seps.length > 0) {
        const lastSep = seps[seps.length - 1].textContent;
        if (lastSep === formatDate(msg.created_at)) needsDateSep = false;
      }
    }
    if (needsDateSep) {
      const sep = document.createElement('div');
      sep.className = 'date-separator';
      sep.innerHTML = `<span>${formatDate(msg.created_at)}</span>`;
      messagesContainer.appendChild(sep);
    }
    // Don't duplicate
    if (messagesContainer.querySelector(`.message-wrapper[data-id="${msg.id}"]`)) return;
    messagesContainer.appendChild(createMessageEl(msg));
  }

  function scrollToBottom() {
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }

  // --- Search ---
  let searchDebounce = null;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchDebounce);
    const q = searchInput.value.trim();
    if (!q) { searchResults.classList.remove('visible'); return; }
    searchDebounce = setTimeout(async () => {
      try {
        const data = await api(`/api/users/search?q=${encodeURIComponent(q)}`);
        if (data.users.length === 0) {
          searchResults.innerHTML = '<div class="search-no-results">No users found</div>';
        } else {
          searchResults.innerHTML = data.users.map(u => `
            <div class="search-result-item" data-user-id="${u.id}">
              <img src="${escapeHtml(u.avatar_url)}" alt="">
              <div>
                <div class="name">${escapeHtml(u.display_name || u.username)}</div>
                <div class="username">@${escapeHtml(u.username)}</div>
              </div>
              <div class="status-dot ${u.is_online ? 'online' : 'offline'}"></div>
            </div>
          `).join('');
          searchResults.querySelectorAll('.search-result-item').forEach(el => {
            el.addEventListener('click', () => startChatWith(parseInt(el.dataset.userId)));
          });
        }
        searchResults.classList.add('visible');
      } catch (err) {
        showToast('Search failed');
      }
    }, 300);
  });

  // Close search on outside click
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-container')) {
      searchResults.classList.remove('visible');
    }
  });

  async function startChatWith(targetUserId) {
    searchResults.classList.remove('visible');
    searchInput.value = '';
    try {
      const data = await api('/api/chats', {
        method: 'POST',
        body: JSON.stringify({ targetUserId })
      });
      const chat = data.chat;
      // Add to chats list if not exists
      if (!chats.find(c => c.id === chat.id)) {
        chats.unshift(chat);
        renderChatList();
      }
      openChat(chat.id, chat.otherUser);
    } catch (err) {
      showToast(err.message);
    }
  }

  // --- Send Message ---
  function sendMessage() {
    const content = messageInput.value.trim();
    if (!content || !activeChatId) return;
    socket.emit('message:send', { chatId: activeChatId, content, type: 'text' });
    messageInput.value = '';
    messageInput.style.height = 'auto';
    stopTyping();
  }

  sendBtn.addEventListener('click', sendMessage);

  messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // Auto-resize textarea
  messageInput.addEventListener('input', () => {
    messageInput.style.height = 'auto';
    messageInput.style.height = Math.min(messageInput.scrollHeight, 100) + 'px';
    // Typing indicator
    if (!isTyping && activeChatId) {
      isTyping = true;
      socket.emit('typing:start', { chatId: activeChatId });
    }
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(stopTyping, 1500);
  });

  function stopTyping() {
    if (isTyping && activeChatId) {
      isTyping = false;
      socket.emit('typing:stop', { chatId: activeChatId });
    }
  }

  // --- Back Button (mobile) ---
  backBtn.addEventListener('click', () => {
    chatApp.classList.remove('chat-open');
  });

  // --- Logout ---
  logoutBtn.addEventListener('click', () => {
    localStorage.removeItem('chat_token');
    localStorage.removeItem('chat_user');
    window.location.href = '/';
  });

  // --- Start ---
  init();
})();
