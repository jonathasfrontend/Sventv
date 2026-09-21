'use strict';

/* =============================================================
   Playlists — gerencia playlists do usuário via API.
   Autenticação: cookie de sessão (httpOnly). As rotas de canais/
   playback exigem API token, então ele é buscado sob demanda em
   GET /api/auth/api-token (autenticado pela sessão).
   ============================================================= */

let apiToken = (() => {
  try { return localStorage.getItem('apiToken') || ''; }
  catch (_) { return ''; }
})();
let _apiTokenPromise = null;

function authHeaders() {
  return apiToken ? { Authorization: `Bearer ${apiToken}` } : {};
}

async function ensureApiToken() {
  if (apiToken) return apiToken;
  if (!_apiTokenPromise) {
    _apiTokenPromise = (async () => {
      try {
        const res = await fetch('/api/auth/api-token', { credentials: 'same-origin', cache: 'no-store' });
        if (res.status === 401) {
          window.location.href = '/login?returnTo=/playlists';
          return '';
        }
        const json = await res.json();
        apiToken = (json && json.data && json.data.apiToken) || '';
        if (apiToken) {
          try { localStorage.setItem('apiToken', apiToken); } catch (_) { /* best-effort */ }
        }
      } catch (_) { /* rede indisponível — a chamada seguinte decide */ }
      return apiToken;
    })().finally(() => { _apiTokenPromise = null; });
  }
  return _apiTokenPromise;
}

async function apiFetchUser(endpoint, options = {}) {
  await ensureApiToken();
  const headers = authHeaders();
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(endpoint, { ...options, headers, credentials: 'same-origin' });
  if (res.status === 401) {
    localStorage.removeItem('apiToken');
    apiToken = '';
    window.location.href = '/login?returnTo=/playlists';
    throw new Error('Não autorizado');
  }
  const json = await res.json();
  if (!res.ok) {
    const e = new Error(json.message || `Erro ${res.status}`);
    e.status = res.status;
    e.json = json;
    throw e;
  }
  return json;
}

/* ── Elementos ──────────────────────────────────────────── */
const createForm       = document.getElementById('createPlaylistForm');
const createSubmitBtn  = document.getElementById('createPlaylistSubmit');
const newPlaylistName  = document.getElementById('newPlaylistName');
const newPlaylistDesc  = document.getElementById('newPlaylistDescription');
const newNameError     = document.getElementById('newPlaylistNameError');
const createAlert      = document.getElementById('createAlert');
const playlistsList    = document.getElementById('playlistsList');
const playlistsEmpty   = document.getElementById('playlistsEmpty');
const detailSection    = document.getElementById('playlistDetail');
const detailTitle      = document.getElementById('detailTitle');
const detailDesc       = document.getElementById('detailDesc');
const detailChannels   = document.getElementById('detailChannels');
const closeDetailBtn   = document.getElementById('closeDetailBtn');

const modal          = document.getElementById('playerModal');
const playerFrame    = document.getElementById('playerFrame');
const modalTitle     = document.getElementById('modalTitle');
const modalLogo      = document.getElementById('modalLogo');
const modalCategory  = document.getElementById('modalCategory');
const modalClose     = document.getElementById('modalClose');
const playerError    = document.getElementById('playerError');

let _activePlaylist = null;

/* ── Helpers ─────────────────────────────────────────────── */
function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function showCreateAlert(message, ok) {
  createAlert.textContent = message;
  createAlert.className = 'form-alert ' + (ok ? '' : 'form-alert--error');
  createAlert.hidden = false;
}

async function fetchPlaybackToken(channelId) {
  await ensureApiToken();
  const res = await fetch(`/api/channels/${encodeURIComponent(channelId)}/playback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    credentials: 'same-origin',
  });
  const json = await res.json();
  if (!res.ok || !json?.data?.playbackToken) {
    throw new Error(json.message || 'Falha ao gerar token de playback');
  }
  return json.data.playbackToken;
}

async function openPlayer(ch, btn) {
  modalTitle.textContent    = ch.name || 'Canal';
  modalCategory.textContent = ch.category || 'Geral';
  playerError.hidden = true;
  if (ch.logo) { modalLogo.src = ch.logo; modalLogo.style.display = ''; }
  else { modalLogo.style.display = 'none'; }

  if (window.SvenUI && btn) SvenUI.setBtnLoading(btn, true);
  try {
    const pbToken = await fetchPlaybackToken(ch.id);
    playerFrame.src = `/api/channels/${encodeURIComponent(ch.id)}/stream?token=${encodeURIComponent(pbToken)}`;
    playerError.hidden = true;
    playerFrame.onerror = () => { playerError.hidden = false; };
  } catch (_) {
    playerError.hidden = false;
  } finally {
    if (window.SvenUI && btn) SvenUI.setBtnLoading(btn, false);
  }

  modal.hidden = false;
  document.body.style.overflow = 'hidden';
}

function closePlayer() {
  modal.hidden = true;
  document.body.style.overflow = '';
  playerFrame.src = 'about:blank';
}

/* ── Render da lista de playlists ────────────────────────── */
async function loadPlaylists(silent) {
  try {
    const json = await apiFetchUser('/api/user/playlists?limit=100');
    const items = (json.data && json.data.items) || [];
    playlistsEmpty.hidden = items.length > 0;

    if (!items.length) {
      playlistsList.innerHTML = '';
      return;
    }

    playlistsList.innerHTML = items.map(p => `
      <div class="playlist-card" data-playlist-id="${esc(p.id)}">
        <div class="playlist-card-body">
          <h3 class="playlist-card-name">${esc(p.name)}</h3>
          <p class="playlist-card-desc">${esc(p.description || 'Sem descrição')}</p>
          <span class="playlist-card-count">${p.channelCount || 0} canal(ais)</span>
        </div>
        <div class="playlist-card-actions">
          <button class="btn btn-primary btn-sm playlist-open">Abrir</button>
          <button class="btn btn-danger btn-sm playlist-delete">Excluir</button>
        </div>
      </div>`).join('');

    playlistsList.querySelectorAll('.playlist-open').forEach((btn, i) => {
      btn.addEventListener('click', () => openPlaylist(items[i], false, btn));
    });
    playlistsList.querySelectorAll('.playlist-delete').forEach((btn, i) => {
      btn.addEventListener('click', () => deletePlaylist(items[i], btn));
    });
  } catch (err) {
    if (!silent) showCreateAlert(err.message, false);
  }
}

/* ── CRUD de playlists ───────────────────────────────────── */
createForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  newNameError.textContent = '';
  const name = newPlaylistName.value.trim();
  if (!name) {
    newNameError.textContent = 'Informe um nome para a playlist.';
    newPlaylistName.focus();
    if (window.SvenUI) SvenUI.setBtnLoading(createSubmitBtn, false);
    return;
  }
  try {
    const json = await apiFetchUser('/api/user/playlists', {
      method: 'POST',
      body: JSON.stringify({ name, description: newPlaylistDesc.value.trim() || undefined }),
    });
    const createdName = json.data?.name || name;
    showCreateAlert(`Playlist "${createdName}" criada.`, true);
    newPlaylistName.value = '';
    newPlaylistDesc.value = '';
    await loadPlaylists();
  } catch (err) {
    showCreateAlert(err.message, false);
  } finally {
    if (window.SvenUI) SvenUI.setBtnLoading(createSubmitBtn, false);
  }
});

async function deletePlaylist(playlist, btn) {
  if (!confirm(`Excluir a playlist "${playlist.name}"?`)) return;
  if (window.SvenUI && btn) SvenUI.setBtnLoading(btn, true);
  try {
    await apiFetchUser(`/api/user/playlists/${encodeURIComponent(playlist.id)}`, { method: 'DELETE' });
    if (_activePlaylist && _activePlaylist.id === playlist.id) closeDetail();
    await loadPlaylists();
  } catch (err) {
    showCreateAlert(err.message, false);
  } finally {
    if (window.SvenUI && btn) SvenUI.setBtnLoading(btn, false);
  }
}

/* ── Detalhe: canais da playlist ─────────────────────────── */
async function openPlaylist(playlist, silent, btn) {
  _activePlaylist = playlist;
  detailSection.hidden = false;
  detailTitle.textContent = playlist.name;
  detailDesc.textContent = playlist.description || '';
  if (!silent) detailChannels.innerHTML = '<p class="playlist-loading">Carregando canais...</p>';
  if (window.SvenUI && btn) SvenUI.setBtnLoading(btn, true);

  try {
    const json = await apiFetchUser(`/api/user/playlists/${encodeURIComponent(playlist.id)}/channels?limit=500`);
    const channels = (json.data && json.data.items) || [];
    if (!channels.length) {
      detailChannels.innerHTML = '<p class="playlist-loading">Esta playlist está vazia.</p>';
      return;
    }
    detailChannels.innerHTML = channels.map(ch => `
      <div class="pcard" data-channel-id="${esc(ch.id)}">
        ${ch.logo
          ? `<img class="pcard-logo" src="${esc(ch.logo)}" alt="" loading="lazy" onerror="this.style.display='none'">`
          : `<div class="pcard-logo pcard-logo-fallback">${esc((ch.name || 'C').charAt(0))}</div>`}
        <div class="pcard-body">
          <span class="pcard-name">${esc(ch.name)}</span>
          <span class="pcard-cat">${esc(ch.category || 'Geral')}</span>
        </div>
        <div class="pcard-actions">
          <button class="btn btn-primary btn-sm ch-watch"><i class="ph ph-play" aria-hidden="true"></i> Assistir</button>
          <button class="btn btn-danger btn-sm ch-remove"><i class="ph ph-x" aria-hidden="true"></i> Remover</button>
        </div>
      </div>`).join('');

    detailChannels.querySelectorAll('.ch-watch').forEach((btn, i) => {
      btn.addEventListener('click', () => openPlayer(channels[i], btn));
    });
    detailChannels.querySelectorAll('.ch-remove').forEach((btn, i) => {
      btn.addEventListener('click', () => removeChannel(playlist.id, channels[i], btn));
    });
    // Ctrl/Alt+Click não interfere: o card inteiro abre o player também.
    detailChannels.querySelectorAll('.pcard').forEach((card, i) => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        openPlayer(channels[i], card.querySelector('.ch-watch'));
      });
    });
  } catch (err) {
    if (!silent) detailChannels.innerHTML = `<p class="playlist-loading">${esc(err.message)}</p>`;
  } finally {
    if (window.SvenUI && btn) SvenUI.setBtnLoading(btn, false);
  }
}

async function removeChannel(playlistId, channel, btn) {
  if (!confirm(`Remover "${channel.name}" da playlist?`)) return;
  if (window.SvenUI && btn) SvenUI.setBtnLoading(btn, true);
  try {
    await apiFetchUser(`/api/user/playlists/${encodeURIComponent(playlistId)}/channels/${encodeURIComponent(channel.id)}`, {
      method: 'DELETE',
    });
    if (_activePlaylist) await openPlaylist(_activePlaylist, true);
    await loadPlaylists(true);
  } catch (err) {
    detailChannels.innerHTML = `<p class="playlist-loading">${esc(err.message)}</p>`;
  } finally {
    if (window.SvenUI && btn) SvenUI.setBtnLoading(btn, false);
  }
}

function closeDetail() {
  _activePlaylist = null;
  detailSection.hidden = true;
  detailChannels.innerHTML = '';
}

/* ── Eventos globais ─────────────────────────────────────── */
closeDetailBtn.addEventListener('click', closeDetail);
modalClose.addEventListener('click', closePlayer);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closePlayer();
    closeDetail();
  }
});

loadPlaylists();

// Realtime: atualiza a lista periodicamente sem sobrepor requisições.
// Se um detalhe estiver aberto, ele é recarregado silenciosamente (sem
// flash de "Carregando..."), mantendo a lista e os canais em sincronia.
if (window.Realtime) {
  Realtime.poll({
    name: 'playlists-list',
    fn: async () => {
      await loadPlaylists(true);
      if (_activePlaylist) await openPlaylist(_activePlaylist, true);
    },
    interval: 30000,
  });
}