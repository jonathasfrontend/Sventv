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
    return;
  }

  // ── CAMINHO 2: SSR não enviou dados (fallback) ────────────
  // Acontece se m3uService falhou no servidor ou em desenvolvimento.
  renderSkeletons();
  try {
    await Promise.all([fetchAllChannels(), fetchCategories()]);
    populateCategoryFilter();
    render();
  } catch (_) { /* erro já exibido no grid */ }
}

init();

