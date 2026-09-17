/* public/js/dashboard.js — Dashboard de Canais */
'use strict';

// ── Data Island (SSR) ────────────────────────────────────────
// O servidor injeta channels, categories e apiToken diretamente
// no HTML. Isso elimina a dependência de fetch com token no
// carregamento inicial — os canais aparecem instantaneamente.
const __SSR__ = (() => {
  try {
    const el = document.getElementById('__USER_DATA__');
    return el ? JSON.parse(el.textContent) : {};
  } catch (_) { return {}; }
})();

// Token para chamadas de API subsequentes (filtros, busca, paginação).
// A sessão web (páginas) usa o cookie httpOnly — nunca localStorage.
const apiToken = __SSR__.apiToken || localStorage.getItem('apiToken');
if (!apiToken) {
  window.location.href = '/login';
}

// ── Estado ───────────────────────────────────────────────────
const PAGE_SIZE = 24;

const state = {
  allChannels: __SSR__.channels || [],
  filtered: [],
  categories: __SSR__.categories || [],
  total: __SSR__.totalChannels || 0,
  page: 1,
  search: '',
  category: '',
  view: localStorage.getItem('dashboard_view') || 'grid',
  debounceTimer: null,
  fromSSR: (__SSR__.channels || []).length > 0,
};

let fullDatasetLoaded = !state.fromSSR;
let fullDatasetPromise = null;
let dashboardInitialized = false;

// ── DOM refs ─────────────────────────────────────────────────
const grid           = document.getElementById('channelGrid');
const searchInput    = document.getElementById('searchInput');
const categoryFilter = document.getElementById('categoryFilter');
const paginationEl   = document.getElementById('pagination');
const prevPageBtn    = document.getElementById('prevPage');
const nextPageBtn    = document.getElementById('nextPage');
const pageNumbers    = document.getElementById('pageNumbers');
const totalCount     = document.getElementById('totalCount');
const showingCount   = document.getElementById('showingCount');
const catCount       = document.getElementById('catCount');
const gridViewBtn    = document.getElementById('gridViewBtn');
const listViewBtn    = document.getElementById('listViewBtn');

// Modal
const modal          = document.getElementById('playerModal');
const playerFrame    = document.getElementById('playerFrame');
const modalTitle     = document.getElementById('modalTitle');
const modalLogo      = document.getElementById('modalLogo');
const modalCategory  = document.getElementById('modalCategory');
const modalClose     = document.getElementById('modalClose');
const copyUrlBtn     = document.getElementById('copyUrlBtn');
const playerError    = document.getElementById('playerError');
const retryBtn       = document.getElementById('retryBtn');

// Pessoal (recents / playlists / recomendações)
const recentBlock    = document.getElementById('recentBlock');
const recentList     = document.getElementById('recentList');
const playlistBlock  = document.getElementById('playlistBlock');
const playlistList   = document.getElementById('playlistList');
const recoBlock      = document.getElementById('recoBlock');
const recoList       = document.getElementById('recoList');

// Tendências (Top 10 do catálogo — filmes / séries / ao vivo)
const trendingMoviesBlock    = document.getElementById('trendingMoviesBlock');
const trendingMoviesList     = document.getElementById('trendingMoviesList');
const trendingSeriesBlock    = document.getElementById('trendingSeriesBlock');
const trendingSeriesList     = document.getElementById('trendingSeriesList');
const trendingChannelsBlock  = document.getElementById('trendingChannelsBlock');
const trendingChannelsList   = document.getElementById('trendingChannelsList');

// Save-to-playlist (painel dentro do modal)
const saveToPlaylistBtn   = document.getElementById('saveToPlaylistBtn');
const savePanel           = document.getElementById('savePanel');
const savePlaylistSelect  = document.getElementById('savePlaylistSelect');
const saveNewPlaylistName = document.getElementById('saveNewPlaylistName');
const saveChannelBtn      = document.getElementById('saveChannelBtn');
const savePanelMsg        = document.getElementById('savePanelMsg');

// ── API fetch (filtros/busca/paginação após carga inicial) ────
async function apiFetch(endpoint) {
  const res = await fetch(endpoint, {
    headers: { Authorization: `Bearer ${apiToken}` },
  });
  if (res.status === 401) {
    localStorage.removeItem('apiToken');
    window.location.href = '/login';
    return null;
  }
  if (!res.ok) throw new Error(`Erro ${res.status}`);
  return res.json();
}

// ── Buscar todos os canais via API (fallback ou refresh) ──────
async function fetchAllChannels() {
  try {
    const data = await apiFetch('/api/channels');
    if (!data) return;
    const ch = data.channels || (data.data && data.data.channels) || [];
    state.allChannels = ch;
    state.total = data.total || (data.data && data.data.total) || ch.length;
  } catch (err) {
    grid.innerHTML = `
      <div class="channels-empty">
        ⚠️ Erro ao carregar canais.
        <button onclick="init()" class="btn btn-ghost btn-sm">Tentar novamente</button>
      </div>`;
    throw err;
  }
}

async function ensureFullDataset() {
  if (fullDatasetLoaded) return;

  if (!fullDatasetPromise) {
    fullDatasetPromise = fetchAllChannels()
      .then(() => {
        fullDatasetLoaded = true;
      })
      .finally(() => {
        fullDatasetPromise = null;
      });
  }

  await fullDatasetPromise;
}

// ── Buscar categorias via API (fallback) ──────────────────────
async function fetchCategories() {
  try {
    const data = await apiFetch('/api/channels/categories');
    if (!data) return;
    state.categories = data.categories || (data.data && data.data.categories) || [];
  } catch (err) {
    console.warn('Falha ao carregar categorias:', err.message);
  }
}

// ── Filtro client-side ────────────────────────────────────────
function applyFilters() {
  let list = state.allChannels;

  if (state.search) {
    const q = state.search.toLowerCase();
    list = list.filter(ch =>
      (ch.name || '').toLowerCase().includes(q) ||
      (ch.category || '').toLowerCase().includes(q)
    );
  }

  if (state.category) {
    list = list.filter(ch => ch.category === state.category);
  }

  state.filtered = list;
}

function currentPageChannels() {
  const start = (state.page - 1) * PAGE_SIZE;
  return state.filtered.slice(start, start + PAGE_SIZE);
}

function totalPages() {
  if (!state.search && !state.category) {
    return Math.max(1, Math.ceil(state.total / PAGE_SIZE));
  }
  return Math.max(1, Math.ceil(state.filtered.length / PAGE_SIZE));
}

// ── Populate select de categorias ─────────────────────────────
function populateCategoryFilter() {
  while (categoryFilter.options.length > 1) categoryFilter.remove(1);
  state.categories.forEach(cat => {
    const opt = document.createElement('option');
    opt.value = cat;
    opt.textContent = cat;
    categoryFilter.appendChild(opt);
  });
  if (catCount) catCount.textContent = state.categories.length;
}

// ── Render principal ──────────────────────────────────────────
function render() {
  applyFilters();
  const page  = currentPageChannels();
  const pages = totalPages();

  if (totalCount)   totalCount.textContent  = state.total.toLocaleString('pt-BR');
  if (showingCount) showingCount.textContent = state.filtered.length.toLocaleString('pt-BR');

  if (!page.length && (state.page > 1 || state.filtered.length === 0)) {
    grid.className = 'channel-grid';
    grid.innerHTML = `<div class="channels-empty">🔍 Nenhum canal encontrado para esta busca.</div>`;
    paginationEl.hidden = true;
    return;
  }

  if (!page.length) {
    grid.className = 'channel-grid';
    grid.innerHTML = `<div class="channels-empty">🔍 Nenhum canal encontrado.</div>`;
    paginationEl.hidden = true;
    return;
  }

  grid.className = state.view === 'list' ? 'channel-list' : 'channel-grid';
  grid.innerHTML  = page.map(ch => channelCard(ch)).join('');

  grid.querySelectorAll('.channel-card').forEach((card, i) => {
    card.addEventListener('click', () => openPlayer(page[i]));
  });

  renderPagination(pages);
}

function renderSkeletons() {
  grid.className = 'channel-grid';
  grid.innerHTML = Array.from({ length: PAGE_SIZE }, () => `
    <div class="channel-skeleton">
      <div class="sk-thumb skeleton"></div>
      <div class="sk-body">
        <div class="sk-title skeleton"></div>
        <div class="sk-sub skeleton"></div>
      </div>
    </div>`).join('');
}

// ── Card HTML ─────────────────────────────────────────────────
function channelCard(ch) {
  const name = escapeHtml(ch.name || 'Canal');
  const cat  = escapeHtml(ch.category || 'Geral');
  const logo = ch.logo
    ? `<img class="ch-logo" src="${escapeHtml(ch.logo)}" alt="${name}" loading="lazy" onerror="this.style.display='none'">`
    : `<div class="ch-logo-fallback">${name.charAt(0)}</div>`;

  if (state.view === 'list') {
    return `<div class="channel-card channel-card-list" data-id="${ch.id}">
      <div class="ch-logo-wrap">${logo}</div>
      <div class="ch-info">
        <span class="ch-name">${name}</span>
        <span class="ch-cat">${cat}</span>
      </div>
      <button class="ch-play-btn" aria-label="Assistir">▶</button>
    </div>`;
  }

  return `<div class="channel-card" data-id="${ch.id}">
    <div class="ch-thumb">${logo}<div class="ch-play-overlay">▶</div></div>
    <div class="ch-info">
      <span class="ch-name">${name}</span>
      <span class="ch-cat badge">${cat}</span>
    </div>
  </div>`;
}

// ── Paginação ─────────────────────────────────────────────────
function renderPagination(pages) {
  if (pages <= 1) { paginationEl.hidden = true; return; }
  paginationEl.hidden = false;

  prevPageBtn.disabled = state.page <= 1;
  nextPageBtn.disabled = state.page >= pages;

  const range = [];
  for (let i = Math.max(1, state.page - 2); i <= Math.min(pages, state.page + 2); i++) {
    range.push(i);
  }
  pageNumbers.innerHTML = range.map(p =>
    `<button class="page-num ${p === state.page ? 'active' : ''}" data-page="${p}">${p}</button>`
  ).join('');

  pageNumbers.querySelectorAll('.page-num').forEach(btn => {
    btn.addEventListener('click', () => {
      state.page = +btn.dataset.page;

      if (state.fromSSR && !fullDatasetLoaded) {
        ensureFullDataset().then(() => {
          populateCategoryFilter();
          render();
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }).catch(() => {});
        return;
      }

      render();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });
}

// ── Player Modal (usa o player customizado via iframe) ────────
// A rota GET /api/channels/:id/stream retorna o index.html do
// player personalizado com os dados do canal já preenchidos.
// O token é passado via query string para autenticação.

let _currentChannel = null; // canal aberto no momento

function openPlayer(ch) {
  _currentChannel = ch;

  modalTitle.textContent    = ch.name || 'Canal';
  modalCategory.textContent = ch.category || 'Geral';
  playerError.hidden = true;
  if (savePanel) savePanel.hidden = true;
  if (savePanelMsg) savePanelMsg.hidden = true;

  if (ch.logo) { modalLogo.src = ch.logo; modalLogo.style.display = ''; }
  else { modalLogo.style.display = 'none'; }

  loadPlayerFrame(ch);
  modal.hidden = false;
  document.body.style.overflow = 'hidden';
}

function loadPlayerFrame(ch) {
  if (!ch || !ch.id) {
    playerError.hidden = false;
    return;
  }

  // Busca um playback token curto para este canal e só então carrega
  // o iframe — o API token permanente nunca vai para o player.
  getPlaybackToken(ch.id)
    .then((pbToken) => {
      playerFrame.src = buildStreamUrl(ch.id, pbToken);
      playerError.hidden = true;
      // Detecta falha de carregamento do iframe
      playerFrame.onerror = () => { playerError.hidden = false; };
    })
    .catch(() => {
      playerError.hidden = false;
    });
}

function closeModal() {
  modal.hidden = true;
  // Descarrega o player limpando o src do iframe
  playerFrame.src = 'about:blank';
  _currentChannel = null;
  document.body.style.overflow = '';
}

// ── Eventos ───────────────────────────────────────────────────
modalClose?.addEventListener('click', closeModal);
modal?.addEventListener('click', e => { if (e.target === modal) closeModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

retryBtn?.addEventListener('click', () => {
  if (_currentChannel) {
    playerError.hidden = true;
    loadPlayerFrame(_currentChannel);
  }
});

// ── Pessoal (recents / playlists / recomendações) ────────────
// /api/dashboard é uma chamada privada (session OU api token).
async function apiFetchUser(endpoint, options = {}) {
  const headers = {};
  if (apiToken) headers.Authorization = `Bearer ${apiToken}`;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(endpoint, { ...options, headers, credentials: 'same-origin' });
  if (res.status === 401) {
    localStorage.removeItem('apiToken');
    window.location.href = '/login';
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

function prettyMs(ms) {
  const totalMin = Math.max(0, Math.round((Number(ms) || 0) / 60000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return `${h}h ${m}min`;
  return `${m}min`;
}

function pcardLogo(ch) {
  if (!ch) return '';
  const name = escapeHtml(ch.channelName || ch.name || 'Canal');
  const logo = ch.channelLogo || ch.logo || '';
  return logo
    ? `<img class="pcard-logo" src="${escapeHtml(logo)}" alt="" loading="lazy" onerror="this.style.display='none'">`
    : `<div class="pcard-logo pcard-logo-fallback">${name.charAt(0)}</div>`;
}

function renderRecent(history) {
  if (!history || !history.length) return;
  recentBlock.hidden = false;
  recentList.innerHTML = history.map(h => `
    <button type="button" class="pcard" data-channel-id="${escapeHtml(h.channelId)}">
      ${pcardLogo(h)}
      <div class="pcard-body">
        <span class="pcard-name">${escapeHtml(h.channelName || h.channelId)}</span>
        <span class="pcard-cat">${escapeHtml(h.channelCategory || 'Geral')}</span>
        <span class="pcard-extra">${h.playCount || 0} reprodução(ões) • ${prettyMs(h.totalWatchMs)}</span>
      </div>
    </button>`).join('');
  recentList.querySelectorAll('[data-channel-id]').forEach(btn => {
    btn.addEventListener('click', () => {
      const ch = state.allChannels.find(c => c.id === btn.dataset.channelId);
      if (ch) openPlayer(ch);
    });
  });
  initCarousel(recentBlock);
}

function renderPlaylists(playlists) {
  if (!playlists || !playlists.length) return;
  playlistBlock.hidden = false;
  playlistList.innerHTML = playlists.map(p => `
    <div class="pcard pcard-static">
      <div class="pcard-body">
        <span class="pcard-name">${escapeHtml(p.name)}</span>
        <span class="pcard-cat">${p.channelCount || 0} canal(ais)</span>
      </div>
    </div>`).join('');
  initCarousel(playlistBlock);
}

function renderRecommendations(payload) {
  const items = payload?.items || [];
  const reasons = payload?.reasons || {};
  if (!items.length) return;
  recoBlock.hidden = false;
  recoList.innerHTML = items.map(ch => {
    const reason = reasons[ch.id];
    return `
      <button type="button" class="pcard pcard-reco" data-channel-id="${escapeHtml(ch.id)}">
        ${pcardLogo(ch)}
        <div class="pcard-body">
          <span class="pcard-name">${escapeHtml(ch.name)}</span>
          <span class="pcard-cat">${escapeHtml(ch.category || 'Geral')}</span>
          <span class="pcard-reason">${reason ? escapeHtml(reason.text) : 'Porque combina com o que você assiste.'}</span>
        </div>
      </button>`;
  }).join('');
  recoList.querySelectorAll('[data-channel-id]').forEach(btn => {
    btn.addEventListener('click', () => {
      const ch = state.allChannels.find(c => c.id === btn.dataset.channelId);
      if (ch) openPlayer(ch);
    });
  });
  initCarousel(recoBlock);
}

// ── Tendências (Top 10 do catálogo) ─────────────────────────
// Cards somente exibição: o catálogo não pertence ao grid SvenTV,
// então não abrem player nem navegam. Falha/ausência de dados
// apenas mantém a seção oculta (fail-open do backend + frontend).
function trendingPosterCard(item) {
  const img = item.image
    ? `<img class="tcard-img" src="${escapeHtml(item.image)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`
    : `<div class="tcard-img tcard-img--fallback">${escapeHtml((item.title || '?').charAt(0))}</div>`;
  const meta = [item.rating, item.runTime].filter(Boolean).join(' • ');
  return `
    <div class="pcard pcard-static pcard--poster">
      ${img}
      <div class="pcard-body">
        <span class="pcard-name">${escapeHtml(item.title || 'Sem título')}</span>
        ${meta ? `<span class="pcard-cat">${escapeHtml(meta)}</span>` : ''}
      </div>
    </div>`;
}

function trendingChannelCard(ch) {
  const name = ch.name || ch.channelName || 'Canal';
  const logo = ch.logo
    ? `<img class="pcard-logo" src="${escapeHtml(ch.logo)}" alt="" loading="lazy" onerror="this.style.display='none'">`
    : `<div class="pcard-logo pcard-logo-fallback">${escapeHtml(name.charAt(0))}</div>`;
  return `
    <div class="pcard pcard-static">
      ${logo}
      <div class="pcard-body">
        <span class="pcard-name">${escapeHtml(name)}</span>
        <span class="pcard-cat">${escapeHtml(ch.genre || ch.genreCategory || 'Ao vivo')}</span>
        ${ch.shortName ? `<span class="pcard-extra">${escapeHtml(ch.shortName)}</span>` : ''}
      </div>
    </div>`;
}

function renderTrendingMovies(movies) {
  if (!movies || !movies.length) return;
  trendingMoviesBlock.hidden = false;
  trendingMoviesList.innerHTML = movies.map(trendingPosterCard).join('');
  initCarousel(trendingMoviesBlock);
}

function renderTrendingSeries(series) {
  if (!series || !series.length) return;
  trendingSeriesBlock.hidden = false;
  trendingSeriesList.innerHTML = series.map(trendingPosterCard).join('');
  initCarousel(trendingSeriesBlock);
}

function renderTrendingChannels(channels) {
  if (!channels || !channels.length) return;
  trendingChannelsBlock.hidden = false;
  trendingChannelsList.innerHTML = channels.map(trendingChannelCard).join('');
  initCarousel(trendingChannelsBlock);
}

async function loadTrending() {
  try {
    const json = await apiFetchUser('/api/trending');
    const data = json.data || {};
    renderTrendingMovies(data.movies);
    renderTrendingSeries(data.series);
    renderTrendingChannels(data.channels);
  } catch (err) {
    // Falha silenciosa: os carrosséis de tendências ficam ocultos.
    console.warn('loadTrending:', err.message);
  }
}

// ── Carrossel horizontal ───────────────────────────────────
// O trilho (.personal-cards) rola com scroll-snap; as setas rolam
// ~80% da largura visível por clique e ficam ocultas quando não há
// mais conteúdo para os dois lados.
function initCarousel(block) {
  if (!block || block.dataset.carouselInited) return;
  block.dataset.carouselInited = 'true';

  const track  = block.querySelector('.personal-cards');
  const prev   = block.querySelector('[data-carousel-prev]');
  const next   = block.querySelector('[data-carousel-next]');
  if (!track || !prev || !next) return;

  const updateArrows = () => {
    const maxScroll = track.scrollWidth - track.clientWidth;
    prev.hidden = track.scrollLeft <= 4;
    next.hidden = track.scrollLeft >= maxScroll - 4;
  };

  prev.addEventListener('click', () => {
    track.scrollBy({ left: -(track.clientWidth * 0.8), behavior: 'smooth' });
  });
  next.addEventListener('click', () => {
    track.scrollBy({ left: track.clientWidth * 0.8, behavior: 'smooth' });
  });
  track.addEventListener('scroll', updateArrows, { passive: true });
  window.addEventListener('resize', updateArrows);
  updateArrows();
}

async function loadPersonal() {
  try {
    const json = await apiFetchUser('/api/dashboard');
    const data = json.data || {};
    renderRecent(data.history);
    renderPlaylists(data.playlists);
    renderRecommendations(data.recommendation);
  } catch (err) {
    // Falha silenciosa: o painel de canais continua funcional.
    console.warn('loadPersonal:', err.message);
  }
}

// ── Salvar na playlist (painel no modal do player) ──────────
let _savePlaylists = [];

async function loadSavePlaylists() {
  const json = await apiFetchUser('/api/user/playlists?limit=100');
  _savePlaylists = (json.data && json.data.items) || [];
  while (savePlaylistSelect.options.length > 0) savePlaylistSelect.remove(0);
  if (!_savePlaylists.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'Nenhuma playlist ainda';
    savePlaylistSelect.appendChild(opt);
    return;
  }
  _savePlaylists.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = `${p.name} (${p.channelCount || 0})`;
    savePlaylistSelect.appendChild(opt);
  });
}

function showSaveMsg(message, ok) {
  if (!savePanelMsg) return;
  savePanelMsg.textContent = message;
  savePanelMsg.classList.toggle('save-panel-msg--ok', !!ok);
  savePanelMsg.classList.toggle('save-panel-msg--err', !ok);
  savePanelMsg.hidden = false;
}

saveToPlaylistBtn?.addEventListener('click', async () => {
  if (!_currentChannel?.id) return;
  savePanel.hidden = false;
  showSaveMsg('', false);
  savePanelMsg.hidden = true;
  try {
    await loadSavePlaylists();
    const status = await apiFetchUser(`/api/user/playlists/status/${encodeURIComponent(_currentChannel.id)}`);
    if (status.data) showSaveMsg(`Este canal já está salvo em "${status.data.name}".`, true);
  } catch (_) { /* segue disponível para tentar salvar */ }
});

saveChannelBtn?.addEventListener('click', async () => {
  if (!_currentChannel?.id) return;
  const chId = _currentChannel.id;
  const newName = saveNewPlaylistName ? saveNewPlaylistName.value.trim() : '';
  try {
    if (newName) {
      await apiFetchUser('/api/user/playlists/create-with-channel', {
        method: 'POST',
        body: JSON.stringify({ name: newName, channelId: chId }),
      });
      showSaveMsg(`Playlist "${newName}" criada com o canal.`, true);
    } else {
      const pid = savePlaylistSelect.value;
      if (!pid) { showSaveMsg('Selecione uma playlist ou crie uma nova.', false); return; }
      await apiFetchUser(`/api/user/playlists/${encodeURIComponent(pid)}/channels`, {
        method: 'POST',
        body: JSON.stringify({ channelId: chId }),
      });
      showSaveMsg('Canal salvo na playlist.', true);
    }
    if (saveNewPlaylistName) saveNewPlaylistName.value = '';
    loadPersonal().catch(() => {});
  } catch (err) {
    showSaveMsg(err.message || 'Falha ao salvar o canal.', false);
  }
});

// ── Playback tokens de curta duração ──────────────────────────
// POST /api/channels/:id/playback emite um JWT (~2h) válido apenas
// para o canal solicitado. Tokens são reutilizados enquanto válidos.
const _playbackCache = new Map(); // channelId -> { token, expiresAt }

async function getPlaybackToken(channelId) {
  const cached = _playbackCache.get(channelId);

  if (cached && Date.now() < cached.expiresAt) return cached.token;

  const res = await fetch(`/api/channels/${encodeURIComponent(channelId)}/playback`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiToken}` },
  });

  const json = await res.json();

  if (!res.ok || !json?.data?.playbackToken) {
    throw new Error(json?.message || 'Falha ao obter token de reprodução');
  }

  const { playbackToken, expiresIn } = json.data;
  const ttlMs = Math.max(30_000, (Number(expiresIn) || 7200) * 1000 - 60_000);

  _playbackCache.set(channelId, { token: playbackToken, expiresAt: Date.now() + ttlMs });

  return playbackToken;
}

// Monta a URL do stream com um token de reprodução (nunca o API token)
function buildStreamUrl(channelId, token) {
  if (!channelId || !token) return '';
  return `${window.location.origin}/api/channels/${encodeURIComponent(channelId)}/stream?token=${encodeURIComponent(token)}`;
}

copyUrlBtn?.addEventListener('click', () => {
  if (!_currentChannel?.id) return;

  getPlaybackToken(_currentChannel.id)
    .then((pbToken) => navigator.clipboard.writeText(buildStreamUrl(_currentChannel.id, pbToken)))
    .then(() => {
      copyUrlBtn.textContent = '✓ Copiado!';
      setTimeout(() => (copyUrlBtn.textContent = '📋 Copiar Embed'), 2000);
    })
    .catch(() => {});
});

searchInput?.addEventListener('input', () => {
  clearTimeout(state.debounceTimer);
  state.debounceTimer = setTimeout(() => {
    state.search = searchInput.value.trim();
    state.page = 1;

    if (state.search && !fullDatasetLoaded) {
      ensureFullDataset().then(render).catch(() => {});
      return;
    }

    render();
  }, 300);
});

categoryFilter?.addEventListener('change', () => {
  state.category = categoryFilter.value;
  state.page = 1;

  if (state.category && !fullDatasetLoaded) {
    ensureFullDataset().then(render).catch(() => {});
    return;
  }

  render();
});

prevPageBtn?.addEventListener('click', () => {
  if (state.page > 1) {
    state.page--;

    if (state.fromSSR && !fullDatasetLoaded) {
      ensureFullDataset().then(() => {
        populateCategoryFilter();
        render();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }).catch(() => {});
      return;
    }

    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
});

nextPageBtn?.addEventListener('click', () => {
  if (state.page < totalPages()) {
    state.page++;

    if (state.fromSSR && !fullDatasetLoaded) {
      ensureFullDataset().then(() => {
        populateCategoryFilter();
        render();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }).catch(() => {});
      return;
    }

    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
});

gridViewBtn?.addEventListener('click', () => {
  state.view = 'grid';
  localStorage.setItem('dashboard_view', 'grid');
  gridViewBtn.classList.add('active');
  listViewBtn.classList.remove('active');
  render();
});

listViewBtn?.addEventListener('click', () => {
  state.view = 'list';
  localStorage.setItem('dashboard_view', 'list');
  listViewBtn.classList.add('active');
  gridViewBtn.classList.remove('active');
  render();
});

// ── Helper ────────────────────────────────────────────────────
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Init ──────────────────────────────────────────────────────
async function init() {
  if (dashboardInitialized) return;
  dashboardInitialized = true;

  // Sincroniza botões de visualização com estado salvo
  if (state.view === 'list') {
    listViewBtn.classList.add('active');
    gridViewBtn.classList.remove('active');
  }

  // ── CAMINHO 1: Dados vieram do SSR ───────────────────────
  // Renderiza imediatamente com os primeiros 24 canais injetados
  // pelo servidor, sem nenhuma requisição de rede.
  // Em paralelo, busca o dataset completo para paginação.
  if (state.fromSSR) {
    populateCategoryFilter();
    render();
    ensureFullDataset().then(() => {
      populateCategoryFilter();
    }).catch(() => {});
    loadPersonal();
    loadTrending();
    startRealtimePersonal();
    return;
  }

  // ── CAMINHO 2: SSR não enviou dados (fallback) ────────────
  // Acontece se m3uService falhou no servidor ou em desenvolvimento.
  renderSkeletons();
  try {
    await Promise.all([fetchAllChannels(), fetchCategories()]);
    populateCategoryFilter();
    render();
    loadPersonal();
    loadTrending();
    startRealtimePersonal();
  } catch (_) { /* erro já exibido no grid */ }
}

// Realtime: atualiza histórico/playlists/recomendações periodicamente.
// O helper /js/realtime.js não sobrepõe requisições e pausa em aba oculta.
function startRealtimePersonal() {
  if (!window.Realtime) return;
  Realtime.poll({ name: 'dashboard-personal', fn: loadPersonal, interval: 30000 });
}

init();

