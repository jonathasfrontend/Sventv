'use strict';

if (typeof document === 'undefined') {
  module.exports = {};
} else {

const adminDataEl = document.getElementById('__ADMIN_DATA__');
const adminData = adminDataEl ? JSON.parse(adminDataEl.textContent) : {};
const sessionToken = localStorage.getItem('sessionToken');

if (!sessionToken) {
  window.location.href = '/login?returnTo=/admin';
}

if (!adminData.user || adminData.user.role !== 'admin') {
  window.location.href = '/dashboard';
}

// ── DOM refs ─────────────────────────────────────────────────
const adminAlert       = document.getElementById('adminAlert');
const usersTableBody   = document.getElementById('usersTableBody');
const userSearch       = document.getElementById('userSearch');
const roleFilter       = document.getElementById('roleFilter');
const refreshAdminBtn  = document.getElementById('refreshAdminBtn');
const reloadUsersBtn   = document.getElementById('reloadUsersBtn');
const kpiUsers         = document.getElementById('kpiUsers');

const channelsTableBody    = document.getElementById('channelsTableBody');
const channelSearch        = document.getElementById('channelSearch');
const channelStatusFilter  = document.getElementById('channelStatusFilter');
const channelCategoryFilter = document.getElementById('channelCategoryFilter');
const checkAllChannelsBtn  = document.getElementById('checkAllChannelsBtn');
const reloadChannelsBtn    = document.getElementById('reloadChannelsBtn');
const kpiChannels          = document.getElementById('kpiChannels');
const kpiOnline            = document.getElementById('kpiOnline');
const kpiOffline           = document.getElementById('kpiOffline');

// ── State ────────────────────────────────────────────────────
let usersCache = [];
let plansCache = [];
let channelsCache = [];
let channelCategories = [];
let userSearchTimer = null;
let channelSearchTimer = null;

// ── API helpers ──────────────────────────────────────────────
function authHeaders(json = true) {
  const headers = { Authorization: `Bearer ${sessionToken}` };
  if (json) headers['Content-Type'] = 'application/json';
  return headers;
}

function showAlert(message, type = 'error') {
  if (!adminAlert) return;
  adminAlert.className = `form-alert form-alert-${type}`;
  adminAlert.textContent = message;
  adminAlert.hidden = false;
  if (type === 'success') setTimeout(() => { adminAlert.hidden = true; }, 4000);
}

function hideAlert() {
  if (!adminAlert) return;
  adminAlert.hidden = true;
  adminAlert.textContent = '';
}

async function apiGet(url) {
  const res = await fetch(url, { headers: authHeaders(false) });
  const json = await res.json();
  if (!res.ok) throw new Error(json.message || `Erro ${res.status}`);
  return json;
}

async function apiSend(url, method, body) {
  const res = await fetch(url, {
    method,
    headers: authHeaders(),
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.message || `Erro ${res.status}`);
  return json;
}

function normalizeText(v) {
  return String(v || '').toLowerCase();
}

function timeAgo(isoStr) {
  if (!isoStr) return '—';
  const diff = (Date.now() - new Date(isoStr).getTime()) / 1000;
  if (diff < 60) return `${Math.floor(diff)}s atrás`;
  if (diff < 3600) return `${Math.floor(diff / 60)}min atrás`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h atrás`;
  return `${Math.floor(diff / 86400)}d atrás`;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ════════════════════════════════════════════════════════════
//  CHANNELS
// ════════════════════════════════════════════════════════════

function filteredChannels() {
  const query = normalizeText(channelSearch?.value || '');
  const status = channelStatusFilter?.value || '';
  const category = channelCategoryFilter?.value || '';

  return channelsCache.filter(ch => {
    const matchesQuery = !query ||
      normalizeText(ch.name).includes(query) ||
      normalizeText(ch.category).includes(query);
    const matchesStatus = !status || ch.status === status;
    const matchesCategory = !category || ch.category === category;
    return matchesQuery && matchesStatus && matchesCategory;
  });
}

function renderChannels() {
  if (!channelsTableBody) return;
  const items = filteredChannels();

  if (!items.length) {
    channelsTableBody.innerHTML = '<tr><td colspan="7">Nenhum canal encontrado.</td></tr>';
    return;
  }

  channelsTableBody.innerHTML = items.map(ch => {
    const logoHtml = ch.logo
      ? `<img class="ch-logo" src="${escapeHtml(ch.logo)}" alt="" loading="lazy" onerror="this.outerHTML='<div class=\\'ch-logo-fallback\\'>${escapeHtml(ch.name.charAt(0))}</div>'">`
      : `<div class="ch-logo-fallback">${escapeHtml(ch.name.charAt(0))}</div>`;

    return `
      <tr>
        <td>${logoHtml}</td>
        <td>
          <div class="ch-cell">
            <div>
              <div class="ch-name">${escapeHtml(ch.name)}</div>
            </div>
          </div>
        </td>
        <td><span class="ch-category">${escapeHtml(ch.category)}</span></td>
        <td><span class="ch-format">${escapeHtml(ch.format)}</span></td>
        <td>
          <span class="ch-status ch-status--${ch.status}">
            <span class="ch-status-dot"></span>
            ${ch.status === 'online' ? 'Online' : ch.status === 'offline' ? 'Offline' : 'Não verificado'}
          </span>
        </td>
        <td><span class="ch-checked-at">${timeAgo(ch.checkedAt)}</span></td>
        <td>
          <div class="row-actions">
            <button class="btn btn-ghost btn-sm ch-check-btn" data-check-channel="${ch.id}" title="Verificar saúde">Verificar</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  channelsTableBody.querySelectorAll('[data-check-channel]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const channelId = btn.dataset.checkChannel;
      btn.classList.add('is-loading');
      btn.disabled = true;
      try {
        const res = await apiPost(`/api/admin/channels/${channelId}/check`);
        const ch = channelsCache.find(c => c.id === channelId);
        if (ch) {
          ch.status = res.data.ok ? 'online' : 'offline';
          ch.checkedAt = res.data.checkedAt;
        }
        renderChannels();
        updateChannelKPIs();
      } catch (err) {
        showAlert('Falha ao verificar canal: ' + err.message);
      } finally {
        btn.classList.remove('is-loading');
        btn.disabled = false;
      }
    });
  });
}

async function apiPost(url) {
  const res = await fetch(url, {
    method: 'POST',
    headers: authHeaders(false),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.message || `Erro ${res.status}`);
  return json;
}

function updateChannelKPIs() {
  const total = channelsCache.length;
  const online = channelsCache.filter(c => c.status === 'online').length;
  const offline = channelsCache.filter(c => c.status === 'offline').length;
  if (kpiChannels) kpiChannels.textContent = total;
  if (kpiOnline) kpiOnline.textContent = online;
  if (kpiOffline) kpiOffline.textContent = offline;
}

function populateChannelCategories() {
  if (!channelCategoryFilter) return;
  const cats = new Set(channelsCache.map(c => c.category).filter(Boolean));
  const current = channelCategoryFilter.value;
  while (channelCategoryFilter.options.length > 1) channelCategoryFilter.remove(1);
  [...cats].sort().forEach(cat => {
    const opt = document.createElement('option');
    opt.value = cat;
    opt.textContent = cat;
    channelCategoryFilter.appendChild(opt);
  });
  channelCategoryFilter.value = current;
}

async function loadChannels() {
  const json = await apiGet('/api/admin/channels');
  channelsCache = json.data?.channels || [];
  populateChannelCategories();
  updateChannelKPIs();
  renderChannels();
}

async function checkAllChannels() {
  if (checkAllChannelsBtn) {
    checkAllChannelsBtn.disabled = true;
    checkAllChannelsBtn.textContent = 'Verificando...';
  }
  try {
    await apiPost('/api/admin/channels/check-all');
    await loadChannels();
    showAlert('Verificação de canais concluída.', 'success');
  } catch (err) {
    showAlert('Falha ao verificar canais: ' + err.message);
  } finally {
    if (checkAllChannelsBtn) {
      checkAllChannelsBtn.disabled = false;
      checkAllChannelsBtn.textContent = 'Verificar tudo';
    }
  }
}

async function reloadM3U() {
  if (reloadChannelsBtn) {
    reloadChannelsBtn.disabled = true;
    reloadChannelsBtn.textContent = 'Recarregando...';
  }
  try {
    await apiPost('/api/admin/channels/reload');
    await loadChannels();
    showAlert('Lista de canais recarregada.', 'success');
  } catch (err) {
    showAlert('Falha ao recarregar: ' + err.message);
  } finally {
    if (reloadChannelsBtn) {
      reloadChannelsBtn.disabled = false;
      reloadChannelsBtn.textContent = 'Recarregar M3U';
    }
  }
}

// ════════════════════════════════════════════════════════════
//  USERS (mantido do original)
// ════════════════════════════════════════════════════════════

function filteredUsers() {
  const query = normalizeText(userSearch?.value || '');
  const role = roleFilter?.value || '';
  return usersCache.filter(user => {
    const matchesQuery = !query || normalizeText(user.name).includes(query) || normalizeText(user.email).includes(query);
    const matchesRole = !role || user.role === role;
    return matchesQuery && matchesRole;
  });
}

function renderUsers() {
  if (!usersTableBody) return;
  const items = filteredUsers();

  if (!items.length) {
    usersTableBody.innerHTML = '<tr><td colspan="5">Nenhum usuário encontrado.</td></tr>';
    return;
  }

  usersTableBody.innerHTML = items.map(user => {
    const safeId = user.id;
    return `
      <tr>
        <td>
          <div class="user-cell">
            <strong>${escapeHtml(user.name)}</strong>
            <span>${escapeHtml(user.email)}</span>
          </div>
        </td>
        <td>
          <select class="mini-select" data-role-select="${safeId}">
            <option value="user" ${user.role === 'user' ? 'selected' : ''}>user</option>
            <option value="admin" ${user.role === 'admin' ? 'selected' : ''}>admin</option>
          </select>
        </td>
        <td>
          <select class="mini-select" data-plan-select="${safeId}">
            ${plansCache.map(plan => `<option value="${plan.code}" ${plan.code === user.plan ? 'selected' : ''}>${escapeHtml(plan.name)}</option>`).join('')}
          </select>
        </td>
        <td>
          <div class="status-stack">
            <span class="badge">${escapeHtml(user.status)}</span>
            ${user.accountRestricted ? '<span class="badge badge-danger">restrito</span>' : ''}
          </div>
        </td>
        <td>
          <div class="row-actions">
            <button class="btn btn-ghost btn-sm" data-save-user="${safeId}">Salvar</button>
            <button class="btn btn-danger btn-sm" data-toggle-block="${safeId}">${user.accountRestricted ? 'Desbloquear' : 'Bloquear'}</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  usersTableBody.querySelectorAll('[data-save-user]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const userId = btn.dataset.saveUser;
      const role = usersTableBody.querySelector(`[data-role-select="${userId}"]`)?.value;
      const planCode = usersTableBody.querySelector(`[data-plan-select="${userId}"]`)?.value;
      try {
        await Promise.all([
          apiSend(`/api/admin/users/${userId}/role`, 'PUT', { role }),
          apiSend(`/api/admin/users/${userId}/plan`, 'PUT', { planCode }),
        ]);
        showAlert('Usuário atualizado com sucesso.', 'success');
        await refreshAll();
      } catch (err) {
        showAlert(err.message);
      }
    });
  });

  usersTableBody.querySelectorAll('[data-toggle-block]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const userId = btn.dataset.toggleBlock;
      const user = usersCache.find(item => item.id === userId);
      const blocked = !user?.accountRestricted;
      const reason = blocked ? prompt('Motivo do bloqueio (opcional):', 'Bloqueio administrativo') : '';
      try {
        await apiSend(`/api/admin/users/${userId}/block`, 'PUT', { blocked, reason });
        showAlert(blocked ? 'Conta bloqueada.' : 'Conta desbloqueada.', 'success');
        await refreshAll();
      } catch (err) {
        showAlert(err.message);
      }
    });
  });
}

async function loadUsers() {
  const json = await apiGet('/api/admin/users?limit=100&page=1');
  usersCache = json.data?.users || [];
  if (kpiUsers) kpiUsers.textContent = json.data?.total || usersCache.length;
  renderUsers();
}

// ════════════════════════════════════════════════════════════
//  INIT & EVENTS
// ════════════════════════════════════════════════════════════

async function refreshAll() {
  hideAlert();
  await Promise.all([loadUsers(), loadChannels()]);
}

refreshAdminBtn?.addEventListener('click', () => refreshAll().catch(err => showAlert(err.message)));
reloadUsersBtn?.addEventListener('click', () => loadUsers().catch(err => showAlert(err.message)));
checkAllChannelsBtn?.addEventListener('click', () => checkAllChannels().catch(err => showAlert(err.message)));
reloadChannelsBtn?.addEventListener('click', () => reloadM3U().catch(err => showAlert(err.message)));

userSearch?.addEventListener('input', () => {
  clearTimeout(userSearchTimer);
  userSearchTimer = setTimeout(renderUsers, 200);
});

roleFilter?.addEventListener('change', renderUsers);

channelSearch?.addEventListener('input', () => {
  clearTimeout(channelSearchTimer);
  channelSearchTimer = setTimeout(renderChannels, 200);
});

channelStatusFilter?.addEventListener('change', renderChannels);
channelCategoryFilter?.addEventListener('change', renderChannels);

refreshAll().catch(err => showAlert(err.message));
}
