'use strict';

if (typeof document === 'undefined') {
  module.exports = {};
} else {

const adminDataEl = document.getElementById('__ADMIN_DATA__');
const adminData = adminDataEl ? JSON.parse(adminDataEl.textContent) : {};

// Sessão via cookie httpOnly (mesma origem envia automaticamente).
// Sem token de sessão em localStorage.
if (!adminData.user || adminData.user.role !== 'admin') {
  window.location.href = '/login?returnTo=/admin';
}

// ── DOM refs ─────────────────────────────────────────────────
const adminAlert       = document.getElementById('adminAlert');
const usersGrid        = document.getElementById('usersGrid');
const usersEmpty       = document.getElementById('usersEmpty');
const usersCountLabel  = document.getElementById('usersCountLabel');
const userSearch       = document.getElementById('userSearch');
const roleFilter       = document.getElementById('roleFilter');
const statusFilter     = document.getElementById('statusFilter');
const refreshAdminBtn  = document.getElementById('refreshAdminBtn');
const reloadUsersBtn   = document.getElementById('reloadUsersBtn');
const kpiUsers         = document.getElementById('kpiUsers');

const channelsTableBody    = document.getElementById('channelsTableBody');
const channelSearch        = document.getElementById('channelSearch');
const channelStatusFilter  = document.getElementById('channelStatusFilter');
const channelCategoryFilter = document.getElementById('channelCategoryFilter');
const channelStateFilter   = document.getElementById('channelStateFilter');
const checkAllChannelsBtn  = document.getElementById('checkAllChannelsBtn');
const reloadChannelsBtn    = document.getElementById('reloadChannelsBtn');
const chSelectAll          = document.getElementById('chSelectAll');
const channelBulkBar       = document.getElementById('channelBulkBar');
const channelBulkCount     = document.getElementById('channelBulkCount');
const channelBulkState     = document.getElementById('channelBulkState');
const channelBulkReason    = document.getElementById('channelBulkReason');
const channelBulkApply     = document.getElementById('channelBulkApply');
const channelBulkClear     = document.getElementById('channelBulkClear');
const userBulkBar          = document.getElementById('userBulkBar');
const userBulkCount        = document.getElementById('userBulkCount');
const userBulkReason       = document.getElementById('userBulkReason');
const kpiChannels          = document.getElementById('kpiChannels');
const kpiOnline            = document.getElementById('kpiOnline');
const kpiOffline           = document.getElementById('kpiOffline');
const kpiViewers           = document.getElementById('kpiViewers');
const liveViewersList      = document.getElementById('liveViewersList');
const refreshLiveBtn       = document.getElementById('refreshLiveBtn');

// ── State ────────────────────────────────────────────────────
let usersCache = [];
let channelsCache = [];
let channelCategories = [];
let userSearchTimer = null;
let channelSearchTimer = null;
const selectedChannelIds = new Set();
const selectedUserIds = new Set();

// ── API helpers ──────────────────────────────────────────────
// A autenticação das rotas admin acontece pelo cookie httpOnly de
// sessão enviado automaticamente em fetch same-origin.
function authHeaders(json = true) {
  const headers = {};
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
//  SELEÇÃO EM LOTE (canais + usuários) + EXPORTAÇÃO CSV
// ════════════════════════════════════════════════════════════

function syncSelectAll(totalFiltered) {
  if (!chSelectAll) return;
  const selectedVisible = filteredChannels().filter(ch => selectedChannelIds.has(ch.id)).length;
  chSelectAll.checked = totalFiltered > 0 && selectedVisible === totalFiltered;
  chSelectAll.indeterminate = selectedVisible > 0 && selectedVisible < totalFiltered;
}

function syncBulkBars() {
  if (channelBulkBar && channelBulkCount) {
    const n = selectedChannelIds.size;
    channelBulkBar.hidden = n === 0;
    channelBulkCount.textContent = `${n} selecionado${n === 1 ? '' : 's'}`;
  }
  if (userBulkBar && userBulkCount) {
    const n = selectedUserIds.size;
    userBulkBar.hidden = n === 0;
    userBulkCount.textContent = `${n} selecionado${n === 1 ? '' : 's'}`;
  }
}

function chunkItems(list, size = 50) {
  const chunks = [];
  for (let i = 0; i < list.length; i += size) chunks.push(list.slice(i, i + size));
  return chunks;
}

function setBulkBusy(btn, busyText) {
  if (!btn) return;
  if (window.SvenUI) { SvenUI.setBtnLoading(btn, true, { text: busyText || 'Carregando…' }); return; }
  if (!btn.dataset.restoreText) btn.dataset.restoreText = btn.textContent;
  btn.disabled = true;
  btn.textContent = busyText;
}

function clearBulkBusy(btn) {
  if (!btn) return;
  if (window.SvenUI) { SvenUI.setBtnLoading(btn, false); return; }
  btn.disabled = false;
  btn.textContent = btn.dataset.restoreText || btn.textContent;
}

function bulkErrorSummary(errs) {
  const head = [...errs].slice(0, 3);
  return head.length ? ` ${head.join(' · ')}` : '';
}

function toggleUserSelection(userId, checked) {
  if (checked) selectedUserIds.add(userId);
  else selectedUserIds.delete(userId);
  syncBulkBars();
}

function toggleChannelSelection(channelId, checked) {
  if (checked) selectedChannelIds.add(channelId);
  else selectedChannelIds.delete(channelId);
  syncBulkBars();
}

async function applyChannelBulkState() {
  const ids = [...selectedChannelIds];
  if (!ids.length) return;
  const state = channelBulkState?.value || 'live';
  const reason = (channelBulkReason?.value || '').trim() || undefined;
  try {
    setBulkBusy(channelBulkApply, 'Aplicando...');
    let applied = 0;
    let failed = 0;
    const errs = new Set();
    for (const batch of chunkItems(ids)) {
      const res = await apiSend('/api/admin/channels/bulk-state', 'PUT', {
        items: batch.map(channelId => ({ channelId, state, reason })),
      });
      applied += res.data?.applied || 0;
      failed += res.data?.failed || 0;
      (res.data?.results || []).forEach(r => { if (!r.success && r.error) errs.add(r.error); });
    }
    selectedChannelIds.clear();
    if (channelBulkReason) channelBulkReason.value = '';
    syncSelectAll(0);
    syncBulkBars();
    await loadChannels();
    showAlert(`${applied} canal(is) atualizado(s)${failed ? `, ${failed} falharam` : ''}.${bulkErrorSummary(errs)}`, failed ? 'error' : 'success');
  } catch (err) {
    showAlert('Falha ao aplicar em lote: ' + err.message);
  } finally {
    clearBulkBusy(channelBulkApply);
  }
}

async function runUserBulk(action) {
  const ids = [...selectedUserIds];
  if (!ids.length) return;
  if (action === 'delete' && !window.confirm(`Excluir permanentemente ${ids.length} conta(s)? Esta ação não pode ser desfeita.`)) return;
  const reason = action === 'block' ? (userBulkReason?.value || '').trim() || undefined : undefined;
  const items = ids.map(userId => ({
    userId,
    action,
    ...(reason ? { reason } : {}),
    ...(action === 'delete' ? { confirm: true } : {}),
  }));
  const btn = {
    block: document.getElementById('userBulkBlock'),
    unblock: document.getElementById('userBulkUnblock'),
    promote: document.getElementById('userBulkPromote'),
    demote: document.getElementById('userBulkDemote'),
    delete: document.getElementById('userBulkDelete'),
  }[action];
  try {
    setBulkBusy(btn, 'Processando...');
    let applied = 0;
    let failed = 0;
    const errs = new Set();
    for (const batch of chunkItems(items)) {
      const res = await apiSend('/api/admin/users/bulk', 'PUT', { items: batch });
      applied += res.data?.applied || 0;
      failed += res.data?.failed || 0;
      (res.data?.results || []).forEach(r => { if (!r.success && r.error) errs.add(r.error); });
    }
    selectedUserIds.clear();
    if (userBulkReason) userBulkReason.value = '';
    syncBulkBars();
    await loadUsers();
    const labels = { block: 'bloqueada(s)', unblock: 'desbloqueada(s)', promote: 'promovida(s)', demote: 'rebaixada(s)', delete: 'excluída(s)' };
    showAlert(`${applied} conta(s) ${labels[action]}${failed ? `, ${failed} falharam` : ''}.${bulkErrorSummary(errs)}`, failed ? 'error' : 'success');
  } catch (err) {
    showAlert('Falha na operação em lote: ' + err.message);
  } finally {
    clearBulkBusy(btn);
  }
}

// CSV exports: GET com cookie de sessão → o browser baixa o attachment.
function triggerDownload(url) {
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function exportAnalyticsCsv() {
  const period = analyticsPeriod?.value || 'today';
  triggerDownload(`/api/admin/export/analytics.csv?period=${encodeURIComponent(period)}`);
}

function exportAuditCsv() {
  const fromEl = document.getElementById('auditExportFrom');
  const toEl = document.getElementById('auditExportTo');
  if (!fromEl || !toEl || !fromEl.value || !toEl.value) {
    showAlert('Informe as datas De/Até para exportar a auditoria.');
    return;
  }
  const from = new Date(`${fromEl.value}T00:00:00`);
  const to = new Date(`${toEl.value}T23:59:59.999`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from.getTime() > to.getTime()) {
    showAlert('Intervalo de datas inválido (De deve ser anterior a Até).');
    return;
  }
  if (to.getTime() - from.getTime() > 366 * 24 * 60 * 60 * 1000) {
    showAlert('O intervalo máximo para exportação é de 366 dias.');
    return;
  }
  const qs = `from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`;
  triggerDownload(`/api/admin/export/audit-logs.csv?${qs}`);
}

// ════════════════════════════════════════════════════════════
//  CHANNELS
// ════════════════════════════════════════════════════════════

function filteredChannels() {
  const query = normalizeText(channelSearch?.value || '');
  const status = channelStatusFilter?.value || '';
  const category = channelCategoryFilter?.value || '';
  const state = channelStateFilter?.value || '';

  return channelsCache.filter(ch => {
    const matchesQuery = !query ||
      normalizeText(ch.name).includes(query) ||
      normalizeText(ch.category).includes(query);
    const matchesStatus = !status || ch.status === status;
    const matchesCategory = !category || ch.category === category;
    const matchesState = !state || (ch.state || 'live') === state;
    return matchesQuery && matchesStatus && matchesCategory && matchesState;
  });
}

function channelStateBadge(state) {
  const s = state || 'live';
  const label = s === 'live' ? 'Ao vivo' : s === 'maintenance' ? 'Manutenção' : 'Bloqueado';
  return `<span class="ch-state ch-state--${s}">${label}</span>`;
}

function renderChannels() {
  if (!channelsTableBody) return;
  const items = filteredChannels();

  if (!items.length) {
    channelsTableBody.innerHTML = '<tr><td colspan="9">Nenhum canal encontrado.</td></tr>';
    syncBulkBars();
    syncSelectAll(0);
    return;
  }

  channelsTableBody.innerHTML = items.map(ch => {
    const logoHtml = ch.logo
      ? `<img class="ch-logo" src="${escapeHtml(ch.logo)}" alt="" loading="lazy" onerror="this.outerHTML='<div class=\\'ch-logo-fallback\\'>${escapeHtml(ch.name.charAt(0))}</div>'">`
      : `<div class="ch-logo-fallback">${escapeHtml(ch.name.charAt(0))}</div>`;

    const failoverNote = ch.hasBackup
      ? ` • <span class="ch-failover" title="Fonte ativa">${ch.activeSource === 'backup' ? 'backup' : 'primária'}</span>`
      : '';

    return `
      <tr>
        <td class="ch-col-select"><input type="checkbox" class="ch-row-check" data-select-channel="${ch.id}" ${selectedChannelIds.has(ch.id) ? 'checked' : ''} aria-label="Selecionar ${escapeHtml(ch.name)}"></td>
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
        <td>
          <div class="ch-state-cell">
            ${channelStateBadge(ch.state)}
            <select class="mini-select" data-state-select="${ch.id}">
              <option value="live" ${(ch.state || 'live') === 'live' ? 'selected' : ''}>Ao vivo</option>
              <option value="maintenance" ${ch.state === 'maintenance' ? 'selected' : ''}>Manutenção</option>
              <option value="blocked" ${ch.state === 'blocked' ? 'selected' : ''}>Bloqueado</option>
            </select>
            <button class="btn btn-ghost btn-sm" data-apply-state="${ch.id}">Aplicar</button>
          </div>
        </td>
        <td><span class="ch-checked-at">${timeAgo(ch.checkedAt)}${failoverNote}</span></td>
        <td>
          <div class="row-actions">
            <button class="btn btn-ghost btn-sm ch-check-btn" data-check-channel="${ch.id}" title="Verificar saúde">Verificar</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  channelsTableBody.querySelectorAll('[data-select-channel]').forEach(cb => {
    cb.addEventListener('change', () => {
      if (cb.checked) selectedChannelIds.add(cb.dataset.selectChannel);
      else selectedChannelIds.delete(cb.dataset.selectChannel);
      syncBulkBars();
      syncSelectAll(items.length);
    });
  });

  syncBulkBars();
  syncSelectAll(items.length);

  channelsTableBody.querySelectorAll('[data-check-channel]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const channelId = btn.dataset.checkChannel;
      if (window.SvenUI) SvenUI.setBtnLoading(btn, true);
      else { btn.classList.add('is-loading'); btn.disabled = true; }
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
        if (window.SvenUI) SvenUI.setBtnLoading(btn, false);
        else { btn.classList.remove('is-loading'); btn.disabled = false; }
      }
    });
  });

  channelsTableBody.querySelectorAll('[data-apply-state]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const channelId = btn.dataset.applyState;
      const select = channelsTableBody.querySelector(`[data-state-select="${channelId}"]`);
      const state = select?.value || 'live';
      const current = channelsCache.find(c => c.id === channelId);
      if (current && (current.state || 'live') === state) return;

      let reason = '';
      if (state !== 'live') {
        reason = prompt('Motivo (opcional):', state === 'blocked' ? 'Bloqueio administrativo' : 'Manutenção programada') || '';
      }

      if (window.SvenUI) SvenUI.setBtnLoading(btn, true);
      else { btn.classList.add('is-loading'); btn.disabled = true; }
      try {
        const res = await apiSend(`/api/admin/channels/${channelId}/state`, 'PUT', { state, reason });
        if (current) {
          current.state = res.data.state;
          current.stateReason = res.data.reason || null;
        }
        renderChannels();
        showAlert(res.message || 'Estado atualizado.', 'success');
      } catch (err) {
        showAlert('Falha ao alterar estado: ' + err.message);
      } finally {
        if (window.SvenUI) SvenUI.setBtnLoading(btn, false);
        else { btn.classList.remove('is-loading'); btn.disabled = false; }
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
  if (checkAllChannelsBtn && window.SvenUI) SvenUI.setBtnLoading(checkAllChannelsBtn, true);
  else if (checkAllChannelsBtn) { checkAllChannelsBtn.disabled = true; checkAllChannelsBtn.textContent = 'Verificando...'; }
  try {
    await apiPost('/api/admin/channels/check-all');
    await loadChannels();
    showAlert('Verificação de canais concluída.', 'success');
  } catch (err) {
    showAlert('Falha ao verificar canais: ' + err.message);
  } finally {
    if (checkAllChannelsBtn && window.SvenUI) SvenUI.setBtnLoading(checkAllChannelsBtn, false);
    else if (checkAllChannelsBtn) { checkAllChannelsBtn.disabled = false; checkAllChannelsBtn.textContent = 'Verificar tudo'; }
  }
}

async function reloadM3U() {
  if (reloadChannelsBtn && window.SvenUI) SvenUI.setBtnLoading(reloadChannelsBtn, true);
  else if (reloadChannelsBtn) { reloadChannelsBtn.disabled = true; reloadChannelsBtn.textContent = 'Recarregando...'; }
  try {
    await apiPost('/api/admin/channels/reload');
    await loadChannels();
    showAlert('Lista de canais recarregada.', 'success');
  } catch (err) {
    showAlert('Falha ao recarregar: ' + err.message);
  } finally {
    if (reloadChannelsBtn && window.SvenUI) SvenUI.setBtnLoading(reloadChannelsBtn, false);
    else if (reloadChannelsBtn) { reloadChannelsBtn.disabled = false; reloadChannelsBtn.textContent = 'Recarregar M3U'; }
  }
}

// ════════════════════════════════════════════════════════════
//  USERS — cards + modal de gerenciamento
// ════════════════════════════════════════════════════════════

function userInitials(name) {
  const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
  const first = parts[0] ? parts[0].charAt(0) : '?';
  const last = parts.length > 1 ? parts[parts.length - 1].charAt(0) : '';
  return (first + last).toUpperCase();
}

function userAvatarHtml(user, sizeClass = '') {
  if (!user.avatar) {
    return `<div class="user-avatar user-avatar--fallback ${sizeClass}">${escapeHtml(userInitials(user.name))}</div>`;
  }
  return `<img class="user-avatar ${sizeClass}" src="${escapeHtml(user.avatar)}" alt="" loading="lazy" onerror="this.outerHTML='<div class=&quot;user-avatar user-avatar--fallback ${sizeClass}&quot;>${escapeHtml(userInitials(user.name))}</div>'">`;
}

function rolePill(user) {
  return `<span class="user-pill user-pill--role-${user.role}">${escapeHtml(user.role)}</span>`;
}

function statusPill(user) {
  const restricted = !!user.accountRestricted;
  const klass = restricted ? 'user-pill--restricted' : `user-pill--status-${user.status}`;
  const label = restricted ? 'restrito' : user.status;
  return `<span class="user-pill ${klass}">${label}</span>`;
}

function isAdminSelf(user) {
  const self = adminData?.user || {};
  return user && (self.id || self._id) && String(user.id) === String(self.id || self._id);
}

function filteredUsers() {
  const query = normalizeText(userSearch?.value || '');
  const role = roleFilter?.value || '';
  const status = statusFilter?.value || '';
  return usersCache.filter(user => {
    const activeStatus = user.accountRestricted ? 'restricted' : user.status;
    const matchesQuery = !query || normalizeText(user.name).includes(query) || normalizeText(user.email).includes(query);
    const matchesRole = !role || user.role === role;
    const matchesStatus = !status || activeStatus === status;
    return matchesQuery && matchesRole && matchesStatus;
  });
}

function renderUsers() {
  if (!usersGrid) return;
  const items = filteredUsers();
  const showEmpty = !items.length;
  if (usersEmpty) usersEmpty.hidden = !showEmpty;
  usersGrid.innerHTML = showEmpty ? '' : items.map(user => {
    const self = isAdminSelf(user);
    return `
      <article class="user-card ${self ? 'is-self' : ''}">
        <div class="user-card-head">
          ${self ? '' : `<input type="checkbox" class="user-row-check" data-select-user="${escapeHtml(user.id)}" ${selectedUserIds.has(user.id) ? 'checked' : ''} aria-label="Selecionar ${escapeHtml(user.name)}">`}
          ${userAvatarHtml(user)}
          <div>
            <span class="user-card-name">${escapeHtml(user.name)}</span>
            <span class="user-card-email">${escapeHtml(user.email)}</span>
          </div>
        </div>
        <div class="user-card-badges">
          ${rolePill(user)}
          ${statusPill(user)}
        </div>
        <div class="user-card-meta">
          <span>Criado ${timeAgo(user.createdAt)}</span>
          ${user.lastLogin ? `<span>Último login ${timeAgo(user.lastLogin)}</span>` : ''}
          ${user.lastLoginIp ? `<span>IP de acesso ${escapeHtml(user.lastLoginIp)}</span>` : ''}
          ${user.accountRestricted && user.restrictedReason ? `<span title="${escapeHtml(user.restrictedReason)}">Motivo: ${escapeHtml(user.restrictedReason)}</span>` : ''}
        </div>
        <div class="user-card-actions">
          <button type="button" class="btn btn-ghost btn-sm" data-manage-user="${escapeHtml(user.id)}">Gerenciar</button>
        </div>
      </article>`;
  }).join('');
  bindUserCardEvents();
}

function bindUserCardEvents() {
  usersGrid.querySelectorAll('[data-select-user]').forEach(cb => {
    cb.addEventListener('change', () => toggleUserSelection(cb.dataset.selectUser, cb.checked));
  });
  usersGrid.querySelectorAll('[data-manage-user]').forEach(btn => {
    btn.addEventListener('click', () => openUserModal(btn.dataset.manageUser).catch(err => showAlert(err.message)));
  });
}

async function loadUsers() {
  if (!usersGrid) return;
  const json = await apiGet('/api/admin/users?limit=500&page=1');
  usersCache = json.data?.users || [];
  const total = json.data?.total ?? usersCache.length;
  if (kpiUsers) kpiUsers.textContent = total;
  if (usersCountLabel) usersCountLabel.textContent = `${total} usuário(s)`;
  renderUsers();
}

// ── Modal de usuário ─────────────────────────────────────────

const userModalOverlay = document.getElementById('userModalOverlay');

let currentUserId = null;
let userDetail = null;

function resetUserModal() {
  const fields = {
    userModalTitle: '—',
    userModalEmail: '',
    userModalBadges: '',
    userModalAvatarBox: '',
    userAvatarFile: '',
    userNameInput: '',
    userEmailInput: '',
    userPassInput: '',
    userPassConfirmInput: '',
    userBlockReason: '',
    userDeleteEmail: '',
  };
  Object.entries(fields).forEach(([id, val]) => {
    const el = document.getElementById(id);
    if (el) el.value = val;
  });
  const roleSel = document.getElementById('userRoleSelect');
  if (roleSel) roleSel.value = 'user';
  const statusPillEl = document.getElementById('userStatusPill');
  if (statusPillEl) statusPillEl.textContent = '';
  const blockBtn = document.getElementById('userBlockBtn');
  if (blockBtn) blockBtn.hidden = false;
  const roleSelf = document.getElementById('userRoleSelfHint');
  if (roleSelf) roleSelf.hidden = true;
  const confirmBox = document.getElementById('userBlockConfirm');
  if (confirmBox) confirmBox.hidden = true;
  const delCheck = document.getElementById('userDeleteCheck');
  if (delCheck) delCheck.checked = false;
  const delBtn = document.getElementById('userDeleteBtn');
  if (delBtn) delBtn.disabled = true;
}

function openUserModal(userId) {
  if (!userModalOverlay) return Promise.resolve();
  resetUserModal();
  currentUserId = userId;
  userModalOverlay.hidden = false;
  document.body.style.overflow = 'hidden';
  return apiGet(`/api/admin/users/${encodeURIComponent(userId)}`)
    .then(json => {
      userDetail = json.data.user;
      renderUserDetail();
    })
    .catch(err => {
      closeUserModal();
      showAlert('Falha ao carregar o usuário: ' + err.message);
    });
}

function renderUserDetail() {
  const u = userDetail;
  if (!u) return;
  const self = isAdminSelf(u);
  const title = document.getElementById('userModalTitle');
  if (title) title.textContent = u.name;
  const email = document.getElementById('userModalEmail');
  if (email) email.textContent = u.email;
  const avatarBox = document.getElementById('userModalAvatarBox');
  if (avatarBox) avatarBox.innerHTML = userAvatarHtml(u, 'user-avatar--lg');
  const badges = document.getElementById('userModalBadges');
  if (badges) badges.innerHTML = rolePill(u) + statusPill(u);

  const nameInput = document.getElementById('userNameInput');
  if (nameInput) nameInput.value = u.name;
  const emailInput = document.getElementById('userEmailInput');
  if (emailInput) emailInput.value = u.email;
  const roleSel = document.getElementById('userRoleSelect');
  if (roleSel) {
    roleSel.value = u.role || 'user';
    roleSel.disabled = self && u.role === 'admin';
  }
  const roleSelf = document.getElementById('userRoleSelfHint');
  if (roleSelf) roleSelf.hidden = !self;
  const roleSave = document.getElementById('userRoleSave');
  if (roleSave) roleSave.hidden = self && u.role === 'admin';

  const statusPillEl = document.getElementById('userStatusPill');
  if (statusPillEl) statusPillEl.textContent = u.accountRestricted ? 'Atualmente: restrito' : `Atualmente: ${u.status}`;
  const blockBtn = document.getElementById('userBlockBtn');
  if (blockBtn) {
    const blocked = u.accountRestricted || u.status !== 'active';
    blockBtn.textContent = blocked ? 'Desbloquear' : 'Bloquear';
    blockBtn.hidden = self;
  }
}

function closeUserModal() {
  if (!userModalOverlay) return;
  userModalOverlay.hidden = true;
  document.body.style.overflow = '';
  currentUserId = null;
  userDetail = null;
}

function refreshUserCard() {
  const idx = usersCache.findIndex(item => item.id === currentUserId);
  if (idx !== -1 && userDetail) usersCache[idx] = { ...usersCache[idx], ...userDetail };
  renderUsers();
}

async function withBusy(btn, busyText, fn) {
  if (window.SvenUI) SvenUI.setBtnLoading(btn, true, { text: busyText || 'Carregando…' });
  else btn.disabled = true;
  try {
    await fn();
  } finally {
    if (window.SvenUI) SvenUI.setBtnLoading(btn, false);
    else btn.disabled = false;
  }
}

// ── Ações da modal ───────────────────────────────────────────

document.getElementById('userModalClose').addEventListener('click', closeUserModal);
userModalOverlay.addEventListener('click', e => { if (e.target === userModalOverlay) closeUserModal(); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && userModalOverlay && !userModalOverlay.hidden) closeUserModal();
});

document.getElementById('userProfileSave').addEventListener('click', function () {
  withBusy(this, 'Salvando...', async () => {
    const body = {};
    const name = document.getElementById('userNameInput').value.trim();
    const email = document.getElementById('userEmailInput').value.trim();
    if (name && name !== userDetail?.name) body.name = name;
    if (email && email !== userDetail?.email) body.email = email;
    if (!Object.keys(body).length) { showAlert('Nenhuma alteração no perfil.', 'success'); return; }
    try {
      const res = await apiSend(`/api/admin/users/${currentUserId}/profile`, 'PUT', body);
      userDetail = res.data.user;
      showAlert(res.message || 'Perfil atualizado.', 'success');
      renderUserDetail();
      refreshUserCard();
    } catch (err) { showAlert(err.message); }
  });
});

document.getElementById('userRoleSave').addEventListener('click', function () {
  withBusy(this, 'Salvando...', async () => {
    const role = document.getElementById('userRoleSelect').value;
    if (!role || role === userDetail?.role) { showAlert('Papel não alterado.', 'success'); return; }
    try {
      const res = await apiSend(`/api/admin/users/${currentUserId}/role`, 'PUT', { role });
      userDetail = res.data.user;
      showAlert(res.message || 'Papel atualizado.', 'success');
      renderUserDetail();
      refreshUserCard();
      if (isAdminSelf(userDetail)) location.reload();
    } catch (err) { showAlert(err.message); }
  });
});

document.getElementById('userPassSave').addEventListener('click', function () {
  withBusy(this, 'Redefinindo...', async () => {
    const pw = document.getElementById('userPassInput').value;
    const cp = document.getElementById('userPassConfirmInput').value;
    if (!pw) { showAlert('Informe a nova senha.'); return; }
    if (pw !== cp) { showAlert('As senhas não coincidem.'); return; }
    try {
      const res = await apiSend(`/api/admin/users/${currentUserId}/password`, 'POST', { newPassword: pw, confirmPassword: cp });
      showAlert(res.message || 'Senha redefinida.', 'success');
      document.getElementById('userPassInput').value = '';
      document.getElementById('userPassConfirmInput').value = '';
    } catch (err) { showAlert(err.message); }
  });
});

document.getElementById('userBlockBtn').addEventListener('click', () => {
  const chkAvail = blocked => {
    const id = document.getElementById('userBlockConfirmBtn');
    if (id) id.dataset.mode = blocked ? 'unblock' : 'block';
  };
  const blocked = (userDetail?.accountRestricted || userDetail?.status !== 'active');
  chkAvail(blocked);
  const box = document.getElementById('userBlockConfirm');
  if (box) box.hidden = !box.hidden;
});

document.getElementById('userBlockConfirmBtn').addEventListener('click', function () {
  withBusy(this, 'Confirmando...', async () => {
    const blocked = this.dataset.mode !== 'unblock';
    const reason = document.getElementById('userBlockReason').value.trim() || undefined;
    try {
      const res = await apiSend(`/api/admin/users/${currentUserId}/block`, 'PUT', { blocked, reason });
      userDetail = res.data.user;
      showAlert(res.message || (blocked ? 'Conta bloqueada.' : 'Conta desbloqueada.'), 'success');
      const box = document.getElementById('userBlockConfirm');
      if (box) box.hidden = true;
      document.getElementById('userBlockReason').value = '';
      renderUserDetail();
      refreshUserCard();
    } catch (err) { showAlert(err.message); }
  });
});

document.getElementById('userBlockCancelBtn').addEventListener('click', () => {
  const box = document.getElementById('userBlockConfirm');
  if (box) box.hidden = true;
  document.getElementById('userBlockReason').value = '';
});

const delCheck = document.getElementById('userDeleteCheck');
const delEmail = document.getElementById('userDeleteEmail');
const delBtn = document.getElementById('userDeleteBtn');
function checkDeleteReady() {
  const ok = delCheck.checked && delEmail.value.trim().toLowerCase() === String(userDetail?.email || '').toLowerCase();
  delBtn.disabled = !ok;
}
delCheck.addEventListener('change', checkDeleteReady);
delEmail.addEventListener('input', checkDeleteReady);
delBtn.addEventListener('click', function () {
  withBusy(this, 'Excluindo...', async () => {
    try {
      const res = await apiSend(`/api/admin/users/${currentUserId}`, 'DELETE', { confirm: true });
      showAlert(res.message || 'Conta excluída.', 'success');
      closeUserModal();
      await loadUsers();
    } catch (err) { showAlert(err.message); }
  });
});

document.getElementById('userAvatarSave').addEventListener('click', function () {
  withBusy(this, 'Enviando...', async () => {
    const file = document.getElementById('userAvatarFile').files[0];
    if (!file) { showAlert('Selecione uma imagem.'); return; }
    const fd = new FormData();
    fd.append('avatar', file);
    const res = await fetch(`/api/admin/users/${currentUserId}/avatar`, { method: 'POST', body: fd });
    let json = {};
    try { json = await res.json(); } catch (_) {}
    if (!res.ok) { showAlert(json.message || `Erro ${res.status} no envio.`); return; }
    userDetail = json.data.user;
    showAlert(json.message || 'Avatar atualizado.', 'success');
    renderUserDetail();
    refreshUserCard();
    if (isAdminSelf(userDetail)) location.reload();
  });
});

// ════════════════════════════════════════════════════════════
//  METRICS
// ════════════════════════════════════════════════════════════

const metricEls = {
  proxyRequests:   document.getElementById('metricProxyRequests'),
  playlists:       document.getElementById('metricPlaylists'),
  segments:        document.getElementById('metricSegments'),
  proxyErrors:     document.getElementById('metricProxyErrors'),
  ssrf:            document.getElementById('metricSSRF'),
  activeStreams:   document.getElementById('metricActiveStreams'),
  peakStreams:     document.getElementById('metricPeakStreams'),
  avgProxy:        document.getElementById('metricAvgProxy'),
};
const refreshMetricsBtn = document.getElementById('refreshMetricsBtn');

function setMetricMetric(key, value) {
  const el = metricEls[key];
  if (el) el.textContent = value;
}

function renderMetrics(data) {
  const c = data?.counters || {};
  const lat = data?.latency || {};
  setMetricMetric('proxyRequests', c.proxyRequests ?? '—');
  setMetricMetric('playlists', c.proxyPlaylists ?? '—');
  setMetricMetric('segments', c.proxySegments ?? '—');
  setMetricMetric('proxyErrors', c.proxyErrors ?? '—');
  setMetricMetric('ssrf', c.proxySSRFBlocked ?? '—');
  setMetricMetric('activeStreams', c.activeStreams ?? '—');
  setMetricMetric('peakStreams', c.activeStreamsPeak ?? '—');
  setMetricMetric('avgProxy', lat.avgProxyMs ?? '—');
}

async function loadMetrics() {
  const json = await apiGet('/api/admin/metrics');
  renderMetrics(json.data);
  renderLiveControl(json.data?.liveControl);
}

function renderLiveControl(liveControl) {
  const total = liveControl?.total ?? 0;
  const channels = liveControl?.channels || [];
  if (kpiViewers) kpiViewers.textContent = total;
  if (!liveViewersList) return;

  if (!channels.length) {
    liveViewersList.innerHTML = '<p class="admin-analytics-empty">Nenhum espectador ativo no momento.</p>';
    return;
  }

  liveViewersList.innerHTML = channels.map(c => `
    <div class="admin-live-row">
      <span class="admin-live-name">${escapeHtml(c.channelName || c.channelId)}</span>
      <span class="admin-live-cat">${escapeHtml(c.channelCategory || '—')}</span>
      <span class="admin-live-count">${c.viewers} <small>viewer${c.viewers === 1 ? '' : 's'}</small></span>
    </div>`).join('');
}

// ════════════════════════════════════════════════════════════
//  SEGURANÇA (WAF) — contadores, IPs bloqueados e eventos
// ════════════════════════════════════════════════════════════

const wafCountersEls = {
  wafRequests:      document.getElementById('wafRequests'),
  wafDetected:      document.getElementById('wafDetected'),
  wafBlockedIp:     document.getElementById('wafBlockedIp'),
  wafRateLimited:   document.getElementById('wafRateLimited'),
  securityBlocks:   document.getElementById('securityBlocks'),
  captchaSuccesses: document.getElementById('captchaSuccesses'),
  captchaFailures:  document.getElementById('captchaFailures'),
  googleLogins:     document.getElementById('googleLogins'),
  googleRegisters:  document.getElementById('googleRegisters'),
  googleUserCreated: document.getElementById('googleUserCreated'),
  googleIdMismatch: document.getElementById('googleIdMismatch'),
  googleFailures:   document.getElementById('googleFailures'),
};
const wafBlockedIpsList = document.getElementById('wafBlockedIpsList');
const wafEventCounts = document.getElementById('wafEventCounts');
const wafEventsTableBody = document.getElementById('wafEventsTableBody');

const WAF_ACTION_LABELS = {
  'security.sql_injection.detected': 'SQL injection detectada',
  'security.xss.detected': 'XSS detectado',
  'security.path_traversal.detected': 'Path traversal',
  'security.ssrf.blocked': 'SSRF bloqueado',
  'security.idor.denied': 'IDOR negado',
  'security.rate_limit.exceeded': 'Rate limit excedido',
  'security.auth.bruteforce': 'Bruteforce detectado',
  'security.route.enumeration': 'Enumeração de rotas',
  'security.suspicious.payload': 'Payload suspeito',
};

function wafActionLabel(action) {
  return WAF_ACTION_LABELS[action] || action || '—';
}

function renderWaf(data) {
  const c = data?.counters || {};
  const g = data?.google || {};
  const set = (key, value) => {
    const el = wafCountersEls[key];
    if (el) el.textContent = value ?? '—';
  };
  set('wafRequests', c.wafRequests ?? '—');
  set('wafDetected', c.wafDetected ?? '—');
  set('wafBlockedIp', c.wafBlockedIp ?? '—');
  set('wafRateLimited', c.wafRateLimited ?? '—');
  set('securityBlocks', c.securityBlocks ?? '—');
  set('captchaSuccesses', c.captchaSuccesses ?? '—');
  set('captchaFailures', c.captchaFailures ?? '—');
  set('googleLogins', g.login ?? '—');
  set('googleRegisters', g.register ?? '—');
  set('googleUserCreated', g.userCreated ?? '—');
  set('googleIdMismatch', g.idMismatch ?? '—');
  set('googleFailures', g.failures ?? '—');

  const ips = data?.blockedIps || [];
  if (wafBlockedIpsList) {
    wafBlockedIpsList.innerHTML = ips.length
      ? ips.map(ip => `<span class="admin-waf-ip">${escapeHtml(ip)}</span>`).join('')
      : '<p class="admin-analytics-empty">Nenhum IP configurado.</p>';
  }

  const counts = data?.eventCounts || {};
  const countEntries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (wafEventCounts) {
    wafEventCounts.innerHTML = countEntries.length
      ? countEntries.map(([action, count]) => `
          <span class="admin-waf-count">
            <strong>${count}</strong>
            ${escapeHtml(wafActionLabel(action))}
          </span>`).join('')
      : '<p class="admin-analytics-empty">Sem eventos no período.</p>';
  }

  const events = data?.recentEvents || [];
  if (wafEventsTableBody) {
    wafEventsTableBody.innerHTML = events.length
      ? events.map(e => `
          <tr>
            <td>${escapeHtml(formatDateTime(e.createdAt))}</td>
            <td>${escapeHtml(wafActionLabel(e.action))}</td>
            <td><code>${escapeHtml(e.ip || '—')}</code></td>
            <td><code>${escapeHtml((e.requestId || '').slice(0, 16) || '—')}</code></td>
          </tr>`).join('')
      : '<tr><td colspan="4">Sem eventos de segurança.</td></tr>';
  }
}

async function loadWaf() {
  const json = await apiGet('/api/admin/waf');
  renderWaf(json.data);
}

// ════════════════════════════════════════════════════════════
//  ANALYTICS (agregados de reprodução persistidos)
// ════════════════════════════════════════════════════════════

const analyticsPeriod      = document.getElementById('analyticsPeriod');
const loadAnalyticsBtn     = document.getElementById('loadAnalyticsBtn');
const analyticsLoading     = document.getElementById('analyticsLoading');
const analyticsBody        = document.getElementById('analyticsBody');
const analyticsKpis        = document.getElementById('analyticsKpis');
const analyticsTopChannels = document.getElementById('analyticsTopChannels');
const analyticsCategories  = document.getElementById('analyticsCategories');
const analyticsTopUsers    = document.getElementById('analyticsTopUsers');
const analyticsSeriesBody  = document.getElementById('analyticsSeriesBody');

function fmtDuration(ms) {
  const totalMin = Math.max(0, Math.round((Number(ms) || 0) / 60000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m}min`;
  return `${m}min`;
}

function analyticsListRow(label, value, sub) {
  return `
    <div class="admin-analytics-row">
      <span class="admin-analytics-row-label">${escapeHtml(label)}</span>
      <span class="admin-analytics-row-values">
        <strong>${escapeHtml(value)}</strong>
        <small>${sub ? escapeHtml(sub) : ''}</small>
      </span>
    </div>`;
}

function renderAnalytics(data) {
  const o = data.overview || {};
  const kpis = [
    ['Reproduções', o.sessions ?? '—'],
    ['únicos', o.uniqueUsers ?? '—'],
    ['Canais únicos', o.uniqueChannels ?? '—'],
    ['Tempo total', data.period ? fmtDuration(o.totalWatchMs) : '—'],
    ['Eventos', o.playbackEvents ?? '—'],
    ['Ativos agora', o.activeSessionsNow ?? '—'],
    ['Playlists', o.totalPlaylists ?? '—'],
  ];
  analyticsKpis.innerHTML = kpis.map(([label, value]) => `
    <div class="admin-kpi-card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value))}</strong></div>`).join('');

  analyticsTopChannels.innerHTML = (data.topChannels && data.topChannels.length)
    ? data.topChannels.map(c => analyticsListRow(
        c.name || c.channelId,
        `${c.sessions} sessões`,
        `${c.uniqueViewers} viewers • ${fmtDuration(c.totalWatchMs)}`)).join('')
    : '<p class="admin-analytics-empty">Sem dados no período.</p>';

  analyticsCategories.innerHTML = (data.categories && data.categories.length)
    ? data.categories.map(c => analyticsListRow(
        c.category,
        `${c.sessions} sessões`,
        `${c.uniqueViewers} viewers • ${fmtDuration(c.totalWatchMs)}`)).join('')
    : '<p class="admin-analytics-empty">Sem dados no período.</p>';

  analyticsTopUsers.innerHTML = (data.topUsers && data.topUsers.length)
    ? data.topUsers.map(u => analyticsListRow(
        u.userId,
        `${u.sessions} sessões`,
        `${u.channelsCount} canais • ${fmtDuration(u.totalWatchMs)}`)).join('')
    : '<p class="admin-analytics-empty">Sem dados no período.</p>';

  const rows = data.series || [];
  analyticsSeriesBody.innerHTML = rows.length
    ? rows.map(d => `
        <tr>
          <td>${escapeHtml(d.date)}</td>
          <td>${d.sessions}</td>
          <td>${d.uniqueViewers}</td>
          <td>${fmtDuration(d.totalWatchMs)}</td>
        </tr>`).join('')
    : '<tr><td colspan="4">Sem dados no período.</td></tr>';
}

async function loadAnalytics(silent) {
  if (!analyticsBody) return;
  if (!silent) {
    analyticsLoading.hidden = false;
    analyticsBody.hidden = true;
  }
  try {
    const period = analyticsPeriod?.value || 'today';
    const json = await apiGet(`/api/admin/metrics/analytics?period=${encodeURIComponent(period)}`);
    renderAnalytics(json.data);
    analyticsBody.hidden = false;
  } catch (err) {
    showAlert('Falha ao carregar analytics: ' + err.message);
  } finally {
    analyticsLoading.hidden = true;
  }
}

// ════════════════════════════════════════════════════════════
//  MÉTRICAS DE USUÁRIOS (agregados administrativos)
// ════════════════════════════════════════════════════════════

const userMetricsPeriod      = document.getElementById('userMetricsPeriod');
const loadUserMetricsBtn     = document.getElementById('loadUserMetricsBtn');
const userMetricsLoading     = document.getElementById('userMetricsLoading');
const userMetricsBody        = document.getElementById('userMetricsBody');
const userMetricsKpis        = document.getElementById('userMetricsKpis');
const userMetricsSeries      = document.getElementById('userMetricsSeries');
const userMetricsSeriesEmpty = document.getElementById('userMetricsSeriesEmpty');
const userMetricsSecurity    = document.getElementById('userMetricsSecurity');
const userMetricsTerms       = document.getElementById('userMetricsTerms');

const SECURITY_EVENT_LABELS = {
  'auth.account_locked': 'Bloqueios de conta',
  'auth.password_reset_attempts_exceeded': 'Reset excedido (senha)',
  'admin.user_block': 'Bloqueios por admin',
  'admin.user_unblock': 'Desbloqueios por admin',
  'admin.change_user_role': 'Mudanças de papel',
};

function userMetricsPct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value); // 'novo'
  return `${n > 0 ? '+' : ''}${n.toLocaleString('pt-BR')}%`;
}

function renderUserMetrics(data) {
  const totals = data.totals || {};
  const growth = data.growth || {};
  const eng = data.engagement || {};

  const kpis = [
    ['Novos no período', growth.current ?? '—', growth.growthPct === 'novo' ? 'novo' : userMetricsPct(growth.growthPct)],
    ['Usuários totais', totals.all ?? '—', `${totals.active ?? 0} ativos`],
    ['Bloqueados', totals.blocked ?? '—', ''],
    ['Administradores', totals.admins ?? '—', ''],
    ['Ativos no período', eng.activeInPeriod ?? '—', `${eng.createdInPeriod ?? 0} criados`],
    ['Taxa de ativação', eng.activationRate != null ? `${eng.activationRate}%` : '—', ''],
  ];
  userMetricsKpis.innerHTML = kpis.map(([label, value, sub]) => `
    <div class="admin-kpi-card">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(String(value))}</strong>
      ${sub ? `<small class="admin-kpi-sub">${escapeHtml(sub)}</small>` : ''}
    </div>`).join('');

  const series = Array.isArray(data.series) ? data.series : [];
  const max = series.reduce((acc, d) => Math.max(acc, Number(d.count) || 0), 0);
  userMetricsSeriesEmpty.hidden = series.length > 0;
  userMetricsSeries.innerHTML = series
    .map((d) => {
      const count = Number(d.count) || 0;
      const h = max > 0 ? Math.max(4, Math.round((count / max) * 100)) : 4;
      return `<div class="um-bar" style="height:${h}%" title="${escapeHtml(d.date)}: ${escapeHtml(String(count))}"></div>`;
    })
    .join('');

  const security = Array.isArray(data.security) ? data.security : [];
  userMetricsSecurity.innerHTML = security.length
    ? security
        .map((s) => analyticsListRow(SECURITY_EVENT_LABELS[s.action] || s.action, String(s.count)))
        .join('')
    : '<p class="admin-analytics-empty">Sem dados no período.</p>';

  const terms = data.terms || {};
  const breakdown = Array.isArray(terms.breakdown) ? terms.breakdown : [];
  userMetricsTerms.innerHTML = breakdown.length
    ? breakdown
        .map((t) => analyticsListRow(t.version || '—', String(t.count)))
        .join('') + analyticsListRow('Sem versão registrada', String(terms.withoutTerms ?? 0))
    : '<p class="admin-analytics-empty">Nenhuma aceitação registrada.</p>';
}

async function loadUserMetrics(silent) {
  if (!userMetricsBody) return;
  if (!silent) {
    userMetricsLoading.hidden = false;
    userMetricsBody.hidden = true;
  }
  try {
    const period = userMetricsPeriod?.value || 'week';
    const json = await apiGet(`/api/admin/metrics/users?period=${encodeURIComponent(period)}`);
    renderUserMetrics(json.data);
    userMetricsBody.hidden = false;
  } catch (err) {
    showAlert('Falha ao carregar métricas de usuários: ' + err.message);
  } finally {
    userMetricsLoading.hidden = true;
  }
}

// ════════════════════════════════════════════════════════════
//  AUDIT LOGS
// ════════════════════════════════════════════════════════════

const auditTableBody   = document.getElementById('auditTableBody');
const auditActionFilter = document.getElementById('auditActionFilter');
const loadAuditBtn     = document.getElementById('loadAuditBtn');

let auditCache = [];

function renderAudit() {
  if (!auditTableBody) return;
  if (!auditCache.length) {
    auditTableBody.innerHTML = '<tr><td colspan="6" class="audit-empty">Nenhum evento de auditoria registrado.</td></tr>';
    return;
  }
  auditTableBody.innerHTML = auditCache.map(log => {
    const meta = log.meta ? JSON.stringify(log.meta) : '';
    return `
      <tr>
        <td><span class="audit-meta">${escapeHtml(formatDateTime(log.createdAt))}</span></td>
        <td><span class="audit-action">${escapeHtml(log.action)}</span></td>
        <td><span class="audit-meta">${escapeHtml(log.email || log.userId || '—')}</span></td>
        <td><span class="audit-meta">${escapeHtml(log.channelId || '—')}</span></td>
        <td><span class="audit-meta">${escapeHtml(log.ip || '—')}</span></td>
        <td><span class="audit-reqid" title="${escapeHtml(meta)}">${escapeHtml(log.requestId || '—')}</span></td>
      </tr>
    `;
  }).join('');
}

function formatDateTime(isoStr) {
  if (!isoStr) return '—';
  const d = new Date(isoStr);
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function populateAuditActions() {
  if (!auditActionFilter) return;
  const actions = new Set(auditCache.map(log => log.action).filter(Boolean));
  const current = auditActionFilter.value;
  while (auditActionFilter.options.length > 1) auditActionFilter.remove(1);
  [...actions].sort().forEach(action => {
    const opt = document.createElement('option');
    opt.value = action;
    opt.textContent = action;
    auditActionFilter.appendChild(opt);
  });
  auditActionFilter.value = current;
}

async function loadAudit() {
  const action = auditActionFilter?.value || '';
  const qs = action ? `?action=${encodeURIComponent(action)}` : '';
  const json = await apiGet(`/api/admin/audit-logs${qs}`);
  auditCache = json.data?.logs || [];
  populateAuditActions();
  renderAudit();
}

// ════════════════════════════════════════════════════════════
//  TABS
// ════════════════════════════════════════════════════════════

const tabButtons = Array.from(document.querySelectorAll('.admin-tab'));
const tabPanels = Array.from(document.querySelectorAll('.admin-tabpanel'));

function activateTab(name) {
  tabButtons.forEach(btn => {
    const active = btn.dataset.tab === name;
    btn.classList.toggle('admin-tab--active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  tabPanels.forEach(panel => {
    panel.classList.toggle('admin-tabpanel--active', panel.dataset.panel === name);
  });

  // Atualiza a seção recém-aberta (metadados podem ter mudado)
  if (name === 'metrics') {
    loadMetrics().catch(() => {});
    loadAnalytics().catch(() => {});
    loadUserMetrics().catch(() => {});
  } else if (name === 'channels') {
    loadChannels().catch(() => {});
  } else if (name === 'users') {
    loadUsers().catch(() => {});
  } else if (name === 'audit') {
    loadAudit().catch(() => {});
  } else if (name === 'waf') {
    loadWaf().catch(() => {});
  }
}

tabButtons.forEach(btn => {
  btn.addEventListener('click', () => activateTab(btn.dataset.tab));
});

// ════════════════════════════════════════════════════════════
//  INIT & EVENTS
// ════════════════════════════════════════════════════════════

async function refreshAll() {
  hideAlert();
  await Promise.all([
    loadUsers(),
    loadChannels(),
    Promise.resolve(loadMetrics()).catch(() => {}),
    Promise.resolve(loadAudit()).catch(err => showAlert('Falha ao carregar auditoria: ' + err.message)),
    Promise.resolve(loadAnalytics()).catch(err => showAlert('Falha ao carregar analytics: ' + err.message)),
    Promise.resolve(loadUserMetrics()).catch(err => showAlert('Falha ao carregar métricas de usuários: ' + err.message)),
    Promise.resolve(loadWaf()).catch(err => showAlert('Falha ao carregar segurança (WAF): ' + err.message)),
  ]);
}

function bindLoadButton(btn, fn) {
  btn?.addEventListener('click', async () => {
    if (window.SvenUI) SvenUI.setBtnLoading(btn, true);
    try { await fn(); }
    finally { if (window.SvenUI) SvenUI.setBtnLoading(btn, false); }
  });
}

function bindDownloadButton(btn, fn) {
  btn?.addEventListener('click', () => {
    if (window.SvenUI) SvenUI.setBtnLoading(btn, true);
    fn();
    setTimeout(() => { if (window.SvenUI) SvenUI.setBtnLoading(btn, false); }, 800);
  });
}

bindLoadButton(refreshAdminBtn, () => refreshAll().catch(err => showAlert(err.message)));
bindLoadButton(reloadUsersBtn, () => loadUsers().catch(err => showAlert(err.message)));
bindLoadButton(checkAllChannelsBtn, () => checkAllChannels().catch(err => showAlert(err.message)));
bindLoadButton(reloadChannelsBtn, () => reloadM3U().catch(err => showAlert(err.message)));
bindLoadButton(refreshMetricsBtn, () => loadMetrics().catch(err => showAlert(err.message)));
bindLoadButton(loadAnalyticsBtn, () => loadAnalytics().catch(err => showAlert(err.message)));
bindLoadButton(loadUserMetricsBtn, () => loadUserMetrics().catch(err => showAlert(err.message)));
bindLoadButton(loadAuditBtn, () => loadAudit().catch(err => showAlert(err.message)));
bindLoadButton(refreshWafBtn, () => loadWaf().catch(err => showAlert(err.message)));
bindDownloadButton(document.getElementById('exportAnalyticsBtn'), exportAnalyticsCsv);
bindDownloadButton(document.getElementById('exportAuditBtn'), exportAuditCsv);
analyticsPeriod?.addEventListener('change', () => loadAnalytics().catch(err => showAlert(err.message)));
userMetricsPeriod?.addEventListener('change', () => loadUserMetrics().catch(err => showAlert(err.message)));
auditActionFilter?.addEventListener('change', () => loadAudit().catch(err => showAlert(err.message)));

chSelectAll?.addEventListener('change', e => {
  const checked = e.target.checked;
  if (checked) filteredChannels().forEach(ch => selectedChannelIds.add(ch.id));
  else selectedChannelIds.clear();
  syncBulkBars();
  renderChannels();
});
channelBulkApply?.addEventListener('click', () => applyChannelBulkState().catch(err => showAlert(err.message)));
channelBulkClear?.addEventListener('click', () => {
  selectedChannelIds.clear();
  syncBulkBars();
  renderChannels();
});
document.getElementById('userBulkBlock')?.addEventListener('click', () => runUserBulk('block').catch(err => showAlert(err.message)));
document.getElementById('userBulkUnblock')?.addEventListener('click', () => runUserBulk('unblock').catch(err => showAlert(err.message)));
document.getElementById('userBulkPromote')?.addEventListener('click', () => runUserBulk('promote').catch(err => showAlert(err.message)));
document.getElementById('userBulkDemote')?.addEventListener('click', () => runUserBulk('demote').catch(err => showAlert(err.message)));
document.getElementById('userBulkDelete')?.addEventListener('click', () => runUserBulk('delete').catch(err => showAlert(err.message)));
document.getElementById('userBulkClear')?.addEventListener('click', () => {
  selectedUserIds.clear();
  syncBulkBars();
  renderUsers();
});

(function initAuditExportDates() {
  const fromEl = document.getElementById('auditExportFrom');
  const toEl = document.getElementById('auditExportTo');
  if (!fromEl || !toEl) return;
  const pad = n => String(n).padStart(2, '0');
  const to = new Date();
  const from = new Date(to.getTime() - 29 * 24 * 60 * 60 * 1000);
  fromEl.value = `${from.getFullYear()}-${pad(from.getMonth() + 1)}-${pad(from.getDate())}`;
  toEl.value = `${to.getFullYear()}-${pad(to.getMonth() + 1)}-${pad(to.getDate())}`;
})();

userSearch?.addEventListener('input', () => {
  clearTimeout(userSearchTimer);
  userSearchTimer = setTimeout(renderUsers, 200);
});

roleFilter?.addEventListener('change', renderUsers);
statusFilter?.addEventListener('change', renderUsers);

channelSearch?.addEventListener('input', () => {
  clearTimeout(channelSearchTimer);
  channelSearchTimer = setTimeout(renderChannels, 200);
});

channelStatusFilter?.addEventListener('change', renderChannels);
channelCategoryFilter?.addEventListener('change', renderChannels);
channelStateFilter?.addEventListener('change', renderChannels);
bindLoadButton(refreshLiveBtn, () => loadMetrics().catch(err => showAlert(err.message)));

// ── Realtime ───────────────────────────────────────────────
// Atualiza painéis leves (métricas, auditoria, canais) a cada 30s.
// Analytics só é atualizado no modo "hoje" para não pesar o backend.
// Abas com dados próprios (canais, usuários, auditoria) só são
// recarregadas quando estão abertas.
function activeTabName() {
  const active = tabButtons.find((btn) => btn.classList.contains('admin-tab--active'));
  return active ? active.dataset.tab : '';
}

function startRealtimeAdmin() {
  if (!window.Realtime) return;
  Realtime.poll({
    name: 'admin-light',
    fn: async () => {
      const tab = activeTabName();
      await loadMetrics().catch(() => {});
      if (tab === 'channels') await loadChannels().catch(() => {});
      if (tab === 'users') await loadUsers().catch(() => {});
      if (tab === 'audit') await loadAudit().catch(() => {});
      if (tab === 'waf') await loadWaf().catch(() => {});
      if (tab === 'metrics' && (analyticsPeriod?.value || 'today') === 'today') {
        await loadAnalytics(true).catch(() => {});
      }
      // Métricas de usuários também só no polling da janela mais barata
      // (semana), espelhando a política do analytics — períodos longos são
      // carregados manualmente / na troca do seletor.
      if (tab === 'metrics' && (userMetricsPeriod?.value || 'week') === 'week') {
        await loadUserMetrics(true).catch(() => {});
      }
    },
    interval: 30000,
  });
}

refreshAll().catch(err => showAlert(err.message));
startRealtimeAdmin();
}
