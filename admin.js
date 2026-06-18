// public/js/admin.js
// ============================================================
// SHADOW CHAT — Admin dashboard logic.
// Client-side gate is convenience only; the real enforcement is
// server-side in lib/adminGuard.js (re-checks role from DB on every
// admin API call). A non-admin hitting this page will simply get
// 403s from every fetch and see the Access Denied screen.
// ============================================================

(() => {
  const token = ShadowAPI.getToken();
  if (!token) { window.location.href = '/login.html'; return; }

  const el = (id) => document.getElementById(id);
  let me = ShadowAPI.getUser();
  let currentReportFilter = 'open';
  let moderateTargetUserId = null;

  async function init() {
    try {
      const data = await ShadowAPI.get('/api/auth?action=me');
      me = data.user;
      if (me.role !== 'admin' && me.role !== 'owner') {
        showAccessDenied();
        return;
      }
    } catch {
      showAccessDenied();
      return;
    }

    el('adminShell').style.display = 'flex';
    el('adminRoleLabel').textContent = me.role === 'owner' ? 'Founder / Owner' : 'Administrator';
    if (me.role === 'owner') el('legalNavBtn').style.display = 'flex';

    bindNav();
    bindModals();
    loadOverview();
  }

  function showAccessDenied() {
    el('accessDenied').style.display = 'flex';
  }

  // ---------- Navigation ----------
  function bindNav() {
    document.querySelectorAll('.nav-link').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.nav-link').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        document.querySelectorAll('.admin-tab').forEach((t) => t.style.display = 'none');
        const tab = btn.dataset.tab;
        el(`tab-${tab}`).style.display = 'block';
        if (tab === 'overview') loadOverview();
        if (tab === 'users') loadUsers();
        if (tab === 'reports') loadReports();
        if (tab === 'legal') loadLegalRequests();
        if (tab === 'security') loadSecurityLogs();
      });
    });
  }

  // ---------- Overview ----------
  async function loadOverview() {
    try {
      const { stats } = await ShadowAPI.get('/api/admin?action=stats');
      el('statsGrid').innerHTML = [
        ['Total Users', stats.totalUsers],
        ['Online Now', stats.onlineUsers],
        ['New Today', stats.newUsersToday],
        ['New This Week', stats.newUsersWeek],
        ['Total Messages', stats.totalMessages],
        ['Messages Today', stats.messagesToday],
        ['Open Reports', stats.openReports],
        ['Banned Users', stats.bannedUsers],
        ['Suspended Users', stats.suspendedUsers],
      ].map(([label, value]) => `
        <div class="stat-card"><div class="stat-value">${value}</div><div class="stat-label">${label}</div></div>
      `).join('');

      const events = stats.securityEvents24h;
      el('securityEventsSummary').innerHTML = events.length === 0
        ? 'No security events in the last 24 hours.'
        : events.map((e) => `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border-soft);"><span>${formatEventType(e.type)}</span><strong>${e.count}</strong></div>`).join('');
    } catch (err) {
      el('statsGrid').innerHTML = `<div class="alert alert-error">${err.message}</div>`;
    }
  }

  // ---------- Users ----------
  let usersDebounce = null;
  async function loadUsers(q = '') {
    const tbody = document.querySelector('#usersTable tbody');
    tbody.innerHTML = '<tr><td colspan="6" class="text-tertiary">Loading…</td></tr>';
    try {
      const data = await ShadowAPI.get(`/api/admin?action=users&q=${encodeURIComponent(q)}`);
      if (data.users.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="text-tertiary">No users found.</td></tr>';
        return;
      }
      tbody.innerHTML = data.users.map((u) => `
        <tr>
          <td><strong>${escapeHtml(u.username)}</strong><br><span class="text-tertiary" style="font-size:12px;">${escapeHtml(u.email)}</span></td>
          <td>
            ${u.isBanned ? '<span class="badge badge-banned">Banned</span>' : u.isSuspended ? '<span class="badge badge-suspended">Suspended</span>' : (u.isOnline ? '<span class="badge badge-online">Online</span>' : '<span class="badge badge-offline">Offline</span>')}
          </td>
          <td><span class="badge badge-${u.role}">${u.role}</span></td>
          <td>${formatDate(u.createdAt)}</td>
          <td>${u.location ? `📍 ${u.location.lat.toFixed(3)}, ${u.location.lng.toFixed(3)}` : '<span class="text-tertiary">Not shared</span>'}</td>
          <td><button class="row-action-btn" data-userid="${u.id}" data-username="${escapeHtml(u.username)}">Moderate</button></td>
        </tr>
      `).join('');

      tbody.querySelectorAll('.row-action-btn').forEach((btn) => {
        btn.addEventListener('click', () => openModerateModal(btn.dataset.userid, btn.dataset.username));
      });
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="6"><div class="alert alert-error">${err.message}</div></td></tr>`;
    }
  }

  function bindUserSearch() {
    el('userSearchAdmin').addEventListener('input', (e) => {
      clearTimeout(usersDebounce);
      usersDebounce = setTimeout(() => loadUsers(e.target.value.trim()), 300);
    });
  }

  function openModerateModal(userId, username) {
    moderateTargetUserId = userId;
    el('moderateUserLabel').textContent = username;
    el('moderateReason').value = '';
    el('moderateAlert').innerHTML = '';
    el('moderateModal').style.display = 'flex';
  }

  async function applyModerationAction(action) {
    if (!moderateTargetUserId) return;
    try {
      await ShadowAPI.post('/api/admin?action=moderate-user', {
        userId: moderateTargetUserId,
        action,
        reason: el('moderateReason').value.trim(),
      });
      el('moderateAlert').innerHTML = '<div class="alert alert-success">Action applied.</div>';
      loadUsers(el('userSearchAdmin').value.trim());
      setTimeout(() => { el('moderateModal').style.display = 'none'; }, 900);
    } catch (err) {
      el('moderateAlert').innerHTML = `<div class="alert alert-error">${err.message}</div>`;
    }
  }

  // ---------- Reports ----------
  async function loadReports() {
    const container = el('reportsList');
    container.innerHTML = '<div class="text-tertiary">Loading…</div>';
    try {
      const data = await ShadowAPI.get(`/api/admin?action=reports&status=${currentReportFilter}`);
      if (data.reports.length === 0) {
        container.innerHTML = '<div class="text-tertiary" style="padding:30px;text-align:center;">No reports in this category.</div>';
        return;
      }
      container.innerHTML = data.reports.map((r) => `
        <div class="report-card">
          <div class="report-card-top">
            <div>
              <span class="report-reason-badge">${r.reason}</span>
              <div style="margin-top:6px;font-size:13px;">
                <strong>${escapeHtml(r.reportedUser.username)}</strong>
                <span class="text-tertiary">reported by ${escapeHtml(r.reporter.username)} · ${formatDate(r.createdAt)}</span>
              </div>
            </div>
          </div>
          ${r.messageSnapshot ? `<div class="report-snapshot">"${escapeHtml(r.messageSnapshot)}"</div>` : ''}
          ${r.details ? `<p style="font-size:13.5px;color:var(--text-secondary);">${escapeHtml(r.details)}</p>` : ''}
          <div class="report-actions">
            <button class="row-action-btn" data-action="reviewing" data-id="${r.id}">Mark Reviewing</button>
            <button class="row-action-btn" data-action="resolved" data-id="${r.id}">Resolve</button>
            <button class="row-action-btn" data-action="dismissed" data-id="${r.id}">Dismiss</button>
            <button class="row-action-btn" data-moderate="${r.reportedUser.id}" data-username="${escapeHtml(r.reportedUser.username)}">Moderate User</button>
          </div>
        </div>
      `).join('');

      container.querySelectorAll('[data-action]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          try {
            await ShadowAPI.patch('/api/admin?action=reports', { reportId: btn.dataset.id, status: btn.dataset.action });
            loadReports();
          } catch (err) { alert(err.message); }
        });
      });
      container.querySelectorAll('[data-moderate]').forEach((btn) => {
        btn.addEventListener('click', () => {
          document.querySelector('[data-tab="users"]').click();
          setTimeout(() => openModerateModal(btn.dataset.moderate, btn.dataset.username), 200);
        });
      });
    } catch (err) {
      container.innerHTML = `<div class="alert alert-error">${err.message}</div>`;
    }
  }

  function bindReportFilters() {
    document.querySelectorAll('#reportFilters .pill').forEach((pill) => {
      pill.addEventListener('click', () => {
        document.querySelectorAll('#reportFilters .pill').forEach((p) => p.classList.remove('active'));
        pill.classList.add('active');
        currentReportFilter = pill.dataset.status;
        loadReports();
      });
    });
  }

  // ---------- Legal requests (owner only) ----------
  async function loadLegalRequests() {
    if (me.role !== 'owner') return;
    const container = el('legalRequestsList');
    container.innerHTML = '<div class="text-tertiary">Loading…</div>';
    try {
      const data = await ShadowAPI.get('/api/admin?action=legal-requests');
      if (data.requests.length === 0) {
        container.innerHTML = '<div class="text-tertiary" style="padding:30px;text-align:center;">No legal requests logged yet.</div>';
        return;
      }
      container.innerHTML = data.requests.map((r) => `
        <div class="legal-card">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;">
            <div>
              <strong>${escapeHtml(r.case_reference)}</strong>
              <div class="text-tertiary" style="font-size:12.5px;">From ${escapeHtml(r.requested_by)} · ${formatDate(r.created_at)}</div>
            </div>
            <span class="legal-status ${r.status}">${r.status}</span>
          </div>
          <p style="font-size:13.5px;margin:10px 0 4px;"><strong>Legal basis:</strong> ${escapeHtml(r.legal_basis)}</p>
          <p style="font-size:13.5px;margin:0 0 10px;"><strong>Scope:</strong> ${escapeHtml(r.scope)}</p>
          ${r.target_username ? `<p style="font-size:13px;color:var(--text-secondary);">Target: ${escapeHtml(r.target_username)}</p>` : ''}
          <div class="report-actions">
            <button class="row-action-btn" data-legal-action="approved" data-id="${r.id}">Approve</button>
            <button class="row-action-btn" data-legal-action="denied" data-id="${r.id}">Deny</button>
            <button class="row-action-btn" data-legal-action="fulfilled" data-id="${r.id}">Mark Fulfilled</button>
          </div>
        </div>
      `).join('');

      container.querySelectorAll('[data-legal-action]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          try {
            await ShadowAPI.patch('/api/admin?action=legal-requests', { requestId: btn.dataset.id, status: btn.dataset.legalAction });
            loadLegalRequests();
          } catch (err) { alert(err.message); }
        });
      });
    } catch (err) {
      container.innerHTML = `<div class="alert alert-error">${err.message}</div>`;
    }
  }

  function bindLegalModal() {
    el('newLegalRequestBtn').addEventListener('click', () => {
      ['legalRequestedBy','legalCaseRef','legalBasis','legalTargetUsername','legalScope'].forEach((id) => el(id).value = '');
      el('legalAlert').innerHTML = '';
      el('legalModal').style.display = 'flex';
    });
    el('closeLegalModal').addEventListener('click', () => el('legalModal').style.display = 'none');
    el('submitLegalBtn').addEventListener('click', async () => {
      try {
        await ShadowAPI.post('/api/admin?action=legal-requests', {
          requestedBy: el('legalRequestedBy').value.trim(),
          caseReference: el('legalCaseRef').value.trim(),
          legalBasis: el('legalBasis').value.trim(),
          scope: el('legalScope').value.trim(),
        });
        el('legalAlert').innerHTML = '<div class="alert alert-success">Logged.</div>';
        setTimeout(() => { el('legalModal').style.display = 'none'; loadLegalRequests(); }, 800);
      } catch (err) {
        el('legalAlert').innerHTML = `<div class="alert alert-error">${err.message}</div>`;
      }
    });
  }

  // ---------- Security logs ----------
  async function loadSecurityLogs() {
    const tbody = document.querySelector('#securityTable tbody');
    tbody.innerHTML = '<tr><td colspan="5" class="text-tertiary">Loading…</td></tr>';
    try {
      const data = await ShadowAPI.get('/api/admin?action=security-logs');
      if (data.logs.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="text-tertiary">No events logged.</td></tr>';
        return;
      }
      tbody.innerHTML = data.logs.map((l) => `
        <tr>
          <td>${formatEventType(l.eventType)}</td>
          <td>${l.username ? escapeHtml(l.username) : '<span class="text-tertiary">—</span>'}</td>
          <td class="text-tertiary">${l.ipAddress || '—'}</td>
          <td class="text-tertiary" style="font-size:12px;max-width:260px;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(JSON.stringify(l.metadata || {}))}</td>
          <td class="text-tertiary">${formatDate(l.createdAt)}</td>
        </tr>
      `).join('');
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="5"><div class="alert alert-error">${err.message}</div></td></tr>`;
    }
  }

  // ---------- Modals ----------
  function bindModals() {
    bindUserSearch();
    bindReportFilters();
    bindLegalModal();

    el('closeModerateModal').addEventListener('click', () => el('moderateModal').style.display = 'none');
    el('banBtn').addEventListener('click', () => applyModerationAction('ban'));
    el('unbanBtn').addEventListener('click', () => applyModerationAction('unban'));
    el('suspendBtn').addEventListener('click', () => applyModerationAction('suspend'));
    el('unsuspendBtn').addEventListener('click', () => applyModerationAction('unsuspend'));
  }

  // ---------- Helpers ----------
  function formatEventType(type) {
    return type.split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
  }
  function formatDate(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str ?? '';
    return div.innerHTML;
  }

  init();
})();
