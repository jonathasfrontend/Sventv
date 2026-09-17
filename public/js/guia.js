/* public/js/guia.js — Guia de TV (EPG Grid)
   Grid profissional de programação: timeline de horas no topo, coluna de
   canais fixa à esquerda, células posicionadas pelo eixo do tempo, linha
   do "agora" e detalhes por clique. Consome GET /api/epg/grid. */
'use strict';

// ── Data Island (SSR) ─────────────────────────────────────────
const __SSR__ = (() => {
  try {
    const el = document.getElementById('__USER_DATA__');
    return el ? JSON.parse(el.textContent) : {};
  } catch (_) { return {}; }
})();

const apiToken = __SSR__.apiToken || localStorage.getItem('apiToken');
if (!apiToken) {
  window.location.href = '/login';
}

// ── Constantes do grid ────────────────────────────────────────
const PX_PER_HOUR = 112;      // escala horizontal: px por hora (== CSS .epg-hour)
const HOUR_MS = 60 * 60 * 1000;
const WINDOW_PAST_H = 2;      // horas para trás
const WINDOW_AHEAD_H = 25;    // horas adiante (janela total ≈ 27h)
const REALTIME_POLL_MS = 60000;
const NOW_TICK_MS = 30000;

// ── Estado ────────────────────────────────────────────────────
const state = {
  channels: [],              // canais do /api/epg/grid
  rows: [],                  // { ch, rowEl, bodyEl, cellEls: [{prog, el}] }
  window: null,              // { from, to }
  categories: [],
  search: '',
  category: '',
  debounceTimer: null,
  initialized: false,
};

// ── DOM refs ──────────────────────────────────────────────────
const scrollEl = document.getElementById('epgScroll');
const timelineEl = document.getElementById('epgTimeline');
const rowsEl = document.getElementById('epgRows');
const searchInput = document.getElementById('guiaSearchInput');
const catFilter = document.getElementById('guiaCategoryFilter');
const emptyEl = document.getElementById('guiaEmpty');
const emptyMsg = document.getElementById('guiaEmptyMsg');
const clearBtn = document.getElementById('guiaClearBtn');
const errorEl = document.getElementById('guiaError');
const retryLoad = document.getElementById('guiaRetryLoad');

// Modal de detalhes
const detailModal = document.getElementById('guiaDetailModal');
const dgLogo = document.getElementById('dgLogo');
const dgChannelName = document.getElementById('dgChannelName');
const dgCategory = document.getElementById('dgCategory');
const dgTag = document.getElementById('dgTag');
const dgTitle = document.getElementById('dgTitle');
const dgTime = document.getElementById('dgTime');
const dgDuration = document.getElementById('dgDuration');
const dgDesc = document.getElementById('dgDesc');
const dgWatchBtn = document.getElementById('dgWatchBtn');
const dgClose = document.getElementById('dgClose');

// Modal player
const playerModal = document.getElementById('guiaPlayerModal');
const frame = document.getElementById('guiaPlayerFrame');
const modalLogo = document.getElementById('guiaModalLogo');
const modalName = document.getElementById('guiaModalTitle');
const modalCat = document.getElementById('guiaModalCategory');
const modalNow = document.getElementById('guiaModalNow');
const modalCloseBtn = document.getElementById('guiaModalClose');
const playerError = document.getElementById('guiaPlayerError');
const retryBtn = document.getElementById('guiaRetryBtn');

// ── API fetch ─────────────────────────────────────────────────
async function apiFetch(endpoint) {
  const res = await fetch(endpoint, { headers: { Authorization: `Bearer ${apiToken}` } });
  if (res.status === 401) {
    localStorage.removeItem('apiToken');
    window.location.href = '/login';
    return null;
  }
  if (!res.ok) throw new Error(`Erro ${res.status}`);
  return res.json();
}

// ── Utilitários ───────────────────────────────────────────────
function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtTime(d) {
  if (!d) return '--:--';
  const t = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(t.getTime())) return '--:--';
  return t.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function fmtHour(d) {
  const t = d instanceof Date ? d : new Date(d);
  return `${t.getHours().toString().padStart(2, '0')}h`;
}

function hueFrom(str) {
  if (!str) return 190;
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h % 360;
}

function pxOf(tsMs) {
  return ((tsMs - state.window.from) / HOUR_MS) * PX_PER_HOUR;
}

// Novas linhas do "agora" por linha (mesma coordenada, atualizada junto).
function updateNowLines() {
  if (!state.window) return;
  const nowTs = Date.now();
  const px = Math.min(Math.max(pxOf(nowTs), 2), bodyWidth());
  state.rows.forEach((row, idx) => {
    if (!row.lineEl) return;
    row.lineEl.style.left = `${px}px`;
    const tag = row.lineEl.querySelector('.epg-now-tag');
    if (tag) tag.textContent = fmtTime(new Date(nowTs));
    row.lineEl.hidden = row.rowEl.hidden || px < 2;
  });
  applyLiveClasses();
}

function bodyWidth() {
  if (!state.window) return 0;
  return Math.max(1, ((state.window.to - state.window.from) / HOUR_MS) * PX_PER_HOUR);
}

// ── Carregamento do grid ──────────────────────────────────────
function computeWindow() {
  const now = Date.now();
  const from = Math.floor(now / HOUR_MS) * HOUR_MS - WINDOW_PAST_H * HOUR_MS;
  return { from, to: from + (WINDOW_PAST_H + WINDOW_AHEAD_H) * HOUR_MS };
}

async function loadGrid() {
  state.window = computeWindow();
  const json = await apiFetch(`/api/epg/grid?from=${state.window.from}&to=${state.window.to}`);
  if (!json) return;
  const data = json.data || {};
  state.channels = data.channels || [];
  state.rows = [];

  buildCategories();
  renderTimeline();
  renderRows();
  applyFilters();
  updateNowLines();
  hideError();
}

function renderTimeline() {
  if (!state.window) return;
  const startHour = Math.floor(state.window.from / HOUR_MS);
  const endHour = Math.ceil(state.window.to / HOUR_MS);
  const frag = document.createDocumentFragment();

  const corner = document.createElement('div');
  corner.className = 'epg-corner';
  corner.textContent = 'Guia de TV';
  frag.appendChild(corner);

  for (let h = startHour; h < endHour; h++) {
    const hourDate = new Date(h * HOUR_MS);
    const el = document.createElement('div');
    el.className = 'epg-hour';
    if (hourDate.getHours() === 0) el.classList.add('is-date-break');
    el.textContent = fmtHour(hourDate);
    el.title = `${hourDate.getHours().toString().padStart(2, '0')}:00`;
    el.addEventListener('click', () => scrollToHour(h * HOUR_MS));
    frag.appendChild(el);
  }

  timelineEl.innerHTML = '';
  timelineEl.appendChild(frag);
  timelineEl.style.width = `calc(var(--epg-sb) + ${bodyWidth()}px)`;
  rowsEl.style.width = `${bodyWidth()}px`;
}

function renderRows() {
  rowsEl.innerHTML = '';
  const frag = document.createDocumentFragment();

  state.channels.forEach((ch) => {
    const rowEl = document.createElement('div');
    rowEl.className = 'epg-row';
    rowEl.dataset.id = ch.id;

    const sidebar = document.createElement('div');
    sidebar.className = 'epg-sidebar';
    sidebar.title = `${ch.cleanName || ch.name || 'Canal'} — reproduzir`;
    sidebar.innerHTML = `
      <div class="epg-sidebar-logo">
      ${ch.logo
        ? `<img src="${escapeHtml(ch.logo)}" alt="" loading="lazy" onerror="this.style.display='none'">`
        : escapeHtml(initials(ch.cleanName || ch.name || ''))
      }</div>
      <div class="epg-sidebar-info">
        <div class="epg-sidebar-name">${escapeHtml(ch.cleanName || ch.name || 'Canal')}</div>
        <div class="epg-sidebar-sub">${ch.state === 'live' ? '<span class="live-dot"></span>' : ''}${escapeHtml(ch.category || 'Geral')}</div>
      </div>`;
    sidebar.addEventListener('click', () => openChannel(ch));
    rowEl.appendChild(sidebar);

    const bodyEl = document.createElement('div');
    bodyEl.className = 'epg-body';
    bodyEl.style.width = `${bodyWidth()}px`;

    const progs = (ch.programmes || []).slice().sort((a, b) => new Date(a.start) - new Date(b.start));
    if (!progs.length) {
      const emptyCell = document.createElement('div');
      emptyCell.className = 'epg-prog-empty';
      emptyCell.style.width = '100%';
      emptyCell.textContent = 'Sem programação no período';
      bodyEl.appendChild(emptyCell);
      rowEl.appendChild(bodyEl);
      frag.appendChild(rowEl);
      state.rows.push({ ch, rowEl, bodyEl, cellEls: [], lineEl: null });
      return;
    }

    let cellEls = [];
    for (const prog of progs) {
      const start = new Date(prog.start).getTime();
      const stop = new Date(prog.stop).getTime();
      const left = Math.max(0, pxOf(start));
      const width = Math.max(2, ((stop - start) / HOUR_MS) * PX_PER_HOUR);

      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'epg-prog';
      cell.style.left = `${left}px`;
      cell.style.width = `${width}px`;
      cell.style.setProperty('--hue', hueFrom((prog.categories && prog.categories[0]) || ch.category || ''));
      if (prog.isLive) cell.classList.add('is-now');
      if (ch.state === 'maintenance') cell.classList.add('is-maintenance');
      if (ch.state === 'blocked') cell.classList.add('is-blocked');
      if (width < 26) cell.classList.add('tiny');
      else if (width < 56) cell.classList.add('narrow');

      const timeStr = `${fmtTime(prog.start)} – ${fmtTime(prog.stop)}`;
      cell.innerHTML = `<span class="epg-prog-title">${escapeHtml(prog.title || 'Programação')}</span>
        <span class="epg-prog-time">${timeStr}</span>`;
      const tip = [prog.title, timeStr, prog.description || prog.subtitle || ''].filter(Boolean).join('\n');
      cell.setAttribute('aria-label', `Programa: ${prog.title || ''} ${timeStr}`);
      cell.title = tip;
      cell.addEventListener('click', (e) => { e.stopPropagation(); openDetail(prog, ch); });
      bodyEl.appendChild(cell);
      cellEls.push({ prog, el: cell });
    }
    rowEl.appendChild(bodyEl);
    frag.appendChild(rowEl);

    // Linha do "agora" (tag de hora só na 1ª linha para não poluir).
    const line = document.createElement('div');
    line.className = 'epg-now-line';
    if (state.rows.length === 0) {
      const tag = document.createElement('span');
      tag.className = 'epg-now-tag';
      line.appendChild(tag);
    }
    bodyEl.appendChild(line); // linha por cima das células

    state.rows.push({ ch, rowEl, bodyEl, cellEls, lineEl: line });
  });

  rowsEl.appendChild(frag);
}

// Aplica/remove a classe "is-now" conforme o relógio (programa mudou).
function applyLiveClasses() {
  const nowTs = Date.now();
  state.rows.forEach((row) => {
    row.cellEls.forEach((c) => {
      const s = new Date(c.prog.start).getTime();
      const e = new Date(c.prog.stop).getTime();
      const live = s <= nowTs && nowTs < e;
      c.el.classList.toggle('is-now', live);
    });
  });
}

function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  return (parts[0] ? parts[0][0] : '') + (parts[1] ? parts[1][0] : '');
}

// ── Categorias / filtros ──────────────────────────────────────
function buildCategories() {
  const set = new Set();
  state.channels.forEach((ch) => { if (ch.category) set.add(ch.category); });
  state.categories = [...set].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  catFilter.innerHTML = '<option value="">Todas as categorias</option>';
  state.categories.forEach((cat) => {
    const opt = document.createElement('option');
    opt.value = cat;
    opt.textContent = cat;
    catFilter.appendChild(opt);
  });
}

function matchesQuery(ch) {
  const q = state.search.toLowerCase();
  const hay = [
    ch.cleanName, ch.name, ch.category,
    ...(ch.programmes || []).map((p) => [p.title, p.subtitle, ...(p.categories || [])]).flat(),
  ].filter(Boolean).join(' ').toLowerCase();
  return hay.includes(q);
}

function applyFilters() {
  state.rows.forEach((row) => {
    const okCat = !state.category || row.ch.category === state.category;
    const show = okCat && matchesQuery(row.ch);
    row.rowEl.hidden = !show;
  });
  showEmptyIfNeeded();
  updateNowLines();
}

function showEmptyIfNeeded() {
  if (errorShown()) { emptyEl.hidden = true; return; }
  const any = state.rows.some((row) => !row.rowEl.hidden);
  if (any) { emptyEl.hidden = true; return; }
  emptyMsg.textContent = state.rows.length === 0
    ? '📺 Nenhum canal com programação disponível no momento.'
    : '🔍 Nenhum canal com programação nesta busca.';
  emptyEl.hidden = false;
}

// ── Scroll até o "agora" / uma hora ───────────────────────────
function scrollToHour(tsMs) {
  const target = Math.max(0, pxOf(tsMs) + 8);
  scrollEl.scrollTo({ left: target, behavior: 'smooth' });
}

// ── Modal de detalhes do programa ─────────────────────────────
let _detail = null; // { prog, ch }

function openDetail(prog, ch) {
  _detail = { prog, ch };
  const start = new Date(prog.start).getTime();
  const stop = new Date(prog.stop).getTime();
  const nowTs = Date.now();
  const live = start <= nowTs && nowTs < stop;

  dgChannelName.textContent = ch.cleanName || ch.name || 'Canal';
  dgCategory.textContent = ch.category || 'Geral';
  if (ch.logo) { dgLogo.src = ch.logo; dgLogo.style.display = ''; }
  else { dgLogo.style.display = 'none'; }

  dgTag.textContent = live ? 'Ao vivo' : 'Em breve';
  dgTag.className = `dg-tag ${live ? 'live' : 'upcoming'}`;
  dgTitle.textContent = prog.title || 'Programação';
  dgTime.textContent = `${fmtTime(prog.start)} – ${fmtTime(prog.stop)}`;
  const mins = Math.round((stop - start) / 60000);
  dgDuration.textContent = `${mins} min`;
  dgDesc.textContent = prog.desc2 ? '' : (prog.description || prog.subtitle || 'Descrição indisponível para este programa.');

  if (ch.state === 'live') {
    dgWatchBtn.hidden = false;
    dgWatchBtn.textContent = live ? '▶ Assistir ao vivo' : '▶ Antecipar · assistir agora';
  } else {
    dgWatchBtn.hidden = true;
    dgDesc.textContent = ch.state === 'maintenance'
      ? 'Este canal está em manutenção no momento.'
      : ch.state === 'blocked'
        ? 'Este canal está bloqueado.'
        : dgDesc.textContent;
  }

  detailModal.hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeDetail() {
  detailModal.hidden = true;
  _detail = null;
  if (playerModal.hidden) document.body.style.overflow = '';
}

function openChannel(ch) {
  if (ch.state && ch.state !== 'live') {
    openDetail({ title: (ch.cleanName || ch.name || 'Canal'), description: '', subtitle: '', categories: [], start: new Date(), stop: new Date(Date.now() + 3600000) }, ch);
    return;
  }
  // Fecha o modal de detalhes sem restaurar o scroll (o player segue aberto).
  detailModal.hidden = true;
  _detail = null;

  modalName.textContent = ch.cleanName || ch.name || 'Canal';
  modalCat.textContent = ch.category || 'Geral';
  modalNow.textContent = currentProgram(ch) || 'Programação indisponível';
  playerError.hidden = true;
  if (ch.logo) { modalLogo.src = ch.logo; modalLogo.style.display = ''; }
  else { modalLogo.style.display = 'none'; }
  loadPlayer(ch);
  playerModal.hidden = false;
  document.body.style.overflow = 'hidden';
}

function currentProgram(ch) {
  const nowTs = Date.now();
  const p = (ch.programmes || []).find((x) => {
    const s = new Date(x.start).getTime();
    const e = new Date(x.stop).getTime();
    return s <= nowTs && nowTs < e;
  });
  return p ? `Agora: ${p.title || ''}` : null;
}

// ── Player modal (playback token curto — mesmo fluxo do dashboard) ──
let _current = null;
let _pbCache = new Map();

async function getPlaybackToken(channelId) {
  const cached = _pbCache.get(channelId);
  if (cached && Date.now() < cached.expiresAt) return cached.token;

  const res = await fetch(`/api/channels/${encodeURIComponent(channelId)}/playback`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiToken}` },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json?.data?.playbackToken) {
    throw new Error(json?.message || 'Falha ao obter token de reprodução');
  }
  const ttlMs = Math.max(30_000, (Number(json.data.expiresIn) || 7200) * 1000 - 60_000);
  _pbCache.set(channelId, { token: json.data.playbackToken, expiresAt: Date.now() + ttlMs });
  return json.data.playbackToken;
}

function buildStreamUrl(channelId, token) {
  return `${window.location.origin}/api/channels/${encodeURIComponent(channelId)}/stream?token=${encodeURIComponent(token)}`;
}

function loadPlayer(ch) {
  if (!ch || !ch.id) { playerError.hidden = false; return; }
  getPlaybackToken(ch.id)
    .then((token) => {
      frame.src = buildStreamUrl(ch.id, token);
      playerError.hidden = true;
    })
    .catch(() => { playerError.hidden = false; });
}

function closePlayer() {
  playerModal.hidden = true;
  frame.src = 'about:blank';
  _current = null;
  if (detailModal.hidden) document.body.style.overflow = '';
}

// ── Estados de carregamento / erro ────────────────────────────
function renderSkeletons() {
  rowsEl.innerHTML = Array.from({ length: 10 }, () => `
    <div class="epg-row-skeleton">
      <div class="epg-sk-sidebar">
        <div class="sk-box"></div>
        <span class="sk-bar"></span>
      </div>
      <div class="epg-sk-body">
        <span class="sk-bar"></span><span class="sk-bar"></span><span class="sk-bar"></span>
      </div>
    </div>`).join('');
}

function showError() {
  rowsEl.innerHTML = '';
  errorEl.hidden = false;
  emptyEl.hidden = true;
}
function hideError() { errorEl.hidden = true; }
function errorShown() { return !errorEl.hidden; }

// ── Eventos ───────────────────────────────────────────────────
clearBtn?.addEventListener('click', () => {
  searchInput.value = '';
  state.search = '';
  state.category = '';
  catFilter.value = '';
  applyFilters();
});
retryLoad?.addEventListener('click', () => { init(); });

searchInput?.addEventListener('input', () => {
  clearTimeout(state.debounceTimer);
  state.debounceTimer = setTimeout(() => {
    state.search = searchInput.value.trim();
    applyFilters();
  }, 250);
});

catFilter?.addEventListener('change', () => {
  state.category = catFilter.value;
  applyFilters();
});

// Detail modal
dgClose?.addEventListener('click', closeDetail);
detailModal?.addEventListener('click', (e) => { if (e.target === detailModal) closeDetail(); });
dgWatchBtn?.addEventListener('click', () => {
  if (_detail && _detail.ch) { openChannel(_detail.ch); }
});

// Player modal
modalCloseBtn?.addEventListener('click', closePlayer);
playerModal?.addEventListener('click', (e) => { if (e.target === playerModal) closePlayer(); });
retryBtn?.addEventListener('click', () => { if (_current) loadPlayer(_current); });

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!playerModal.hidden) closePlayer();
  else if (!detailModal.hidden) closeDetail();
});

// ── Init ──────────────────────────────────────────────────────
async function init() {
  if (state.initialized) return;
  state.initialized = true;

  renderSkeletons();
  try {
    await loadGrid();
  } catch (err) {
    showError();
  }

  // Mantém a linha do "agora" e o destaque de programas ao vivo sincronizados.
  setInterval(() => { updateNowLines(); }, NOW_TICK_MS);

  // Realtime: recarrega o grid (novo "agora", nova janela) — o helper
  // pausa em aba oculta.
  if (window.Realtime) {
    Realtime.poll({ name: 'guia', fn: loadGrid, interval: REALTIME_POLL_MS });
  } else {
    setInterval(() => { loadGrid().catch(() => {}); }, REALTIME_POLL_MS);
  }
}

init();