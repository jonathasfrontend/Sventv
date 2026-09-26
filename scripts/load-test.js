'use strict';

/**
 * SvenTV API — Teste de carga local (FASE 5: escalabilidade).
 *
 * Gera carga realista (mix por peso) contra uma instância local. NUNCA aponta
 * para produção: aceita apenas host localhost/127.0.0.1/::1.
 *
 * Autenticação: o caso real de uso é a WebSession (cookie) OU API token.
 *   --token TOKEN        header Authorization: Bearer <TOKEN> em cada request
 *   --cookie SESSION     header Cookie: sessionToken=<SESSION>
 * Sem nenhum dos dois, /api/health e as rotas públicas ainda respondem; as
 * rotas protegidas retornam 401 (contado no breakdown — útil p/ medir custo de
 * rejeição, mas não é o cenário de carga real).
 *
 * Uso:
 *   RATE_LIMIT_MAX_GLOBAL=1000000 RATE_LIMIT_MAX_API=1000000 ^
 *   RATE_LIMIT_MAX_USER=1000000 npm run dev                      # cotas altas p/ medir a app
 *   npm run load-test -- --base http://127.0.0.1:3000 --token <API> \
 *     --duration 30 --concurrency 25 --interval 5
 *
 * Flags:
 *   --base URL         alvo (default http://127.0.0.1:3000)
 *   --token T          API token (Authorization: Bearer)
 *   --cookie C         sessionToken HTTP-only (Cookie)
 *   --admin-cookie C   sessionToken de conta ADMIN — coleta deltas de
 *                      /api/admin/metrics (counters+latência) antes/depois.
 *                      Endpoint de admin só aceita sessão (nunca API token).
 *   --duration N       segundos de carga (default 20)
 *   --concurrency N    requisições simultâneas (default 20)
 *   --interval N       impressão parcial em s (default 5)
 *
 * Saída final (stdout): RPS + p50/p90/p95/p99 latência + erro% + breakdown de
 * status por rota + bloco [ADMIN] com deltas de métricas — formatação estável
 * para scriptar/arquivar.
 */

const http = require('node:http');
const { performance } = require('node:perf_hooks');

// ── Args ───────────────────────────────────────────────────────
function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : def;
}

const BASE = String(arg('base', process.env.LOAD_TEST_BASE || 'http://127.0.0.1:3000')).replace(/\/+$/, '');
const TOKEN = String(arg('token', process.env.LOAD_TEST_TOKEN || ''));
const COOKIE = String(arg('cookie', process.env.LOAD_TEST_COOKIE || ''));
const ADMIN_COOKIE = String(arg('admin-cookie', process.env.LOAD_TEST_ADMIN_COOKIE || ''));
const DURATION_MS = Math.max(2000, (Number(arg('duration', 20)) || 20) * 1000);
const CONCURRENCY = Math.max(1, Math.min(200, Number(arg('concurrency', 20)) || 20));
const INTERVAL_MS = Math.max(1000, (Number(arg('interval', 5)) || 5) * 1000);

// ── Guarda anti-produção ───────────────────────────────────────
function hostOf(u) {
  try { return new URL(u).hostname; } catch { return ''; }
}
const host = hostOf(BASE);
if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
  console.error(`⛔ load-test recusa host não-local: ${host} (${BASE})`);
  process.exit(2);
}
if (!TOKEN && !COOKIE) {
  console.warn('⚠ sem --token nem --cookie — só rotas públicas serão exercitadas em 200.');
}

// ── Mix de rotas ───────────────────────────────────────────────
const querys = {
  channels: ['', '?limit=40', '?category=Filmes', '?search=globo', '?page=1&limit=24'],
  epg: ['', '?limitChannels=24&limitProgrammes=60'],
  grid: [
    '',
    `?from=${Date.now() - 2 * 3600e3}&to=${Date.now() + 8 * 3600e3}&limitChannels=24`,
  ],
  epgSearch: ['?q=globo', '?q=jornal 20h&tz=0', '?q=novela', '?q=futebol 21h30'],
  trending: ['', '/channels'],
  dashboard: [`?windowMs=${24 * 3600e3}`],
  reminders: ['', '?limit=100&upcoming=1'],
};
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// Rotas protegidas usam o mesmo guard (requireSessionOrApi) — enviamos token OU cookie.
const ROUTES = [];
function addRoute(name, basePath, weight, buildPaths) {
  for (let i = 0; i < weight; i++) ROUTES.push({ name, build: () => ({ method: 'GET', path: basePath + pick(buildPaths) }) });
}

addRoute('channels', '/api/channels', 18, querys.channels);
addRoute('epg-list', '/api/epg', 12, querys.epg);
addRoute('epg-grid', '/api/epg/grid', 10, querys.grid);
addRoute('epg-search', '/api/epg/search', 8, querys.epgSearch);
addRoute('trending', '/api/trending', 6, querys.trending);
addRoute('dashboard', '/api/dashboard', 5, querys.dashboard);
addRoute('reminders', '/api/user/reminders', 6, querys.reminders);
addRoute('health', '/api/health', 5, ['']);

// ── Métricas admin (deltas antes/depois) ───────────────────────
const ADMIN_HEADERS = ADMIN_COOKIE ? {
  'User-Agent': 'svenvt-load-test/1.0',
  Cookie: `sessionToken=${ADMIN_COOKIE}`,
} : null;

function fetchJson(path, headers) {
  return new Promise((resolve) => {
    const req = http.request(new URL(BASE + path), { method: 'GET', headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(body); } catch (_) { /* não-JSON */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', () => resolve({ status: 0, json: null }));
    req.end();
  });
}

let preMetrics = null;

async function printAdminMetricsDiff() {
  if (!ADMIN_HEADERS || !preMetrics) return;
  const m = await fetchJson('/api/admin/metrics', ADMIN_HEADERS);
  if (m.status !== 200 || !m.json || !m.json.data) {
    console.log(`[ADMIN] métricas pós-carga indisponíveis (${m.status})`);
    return;
  }
  const post = m.json.data;

  const deltas = [];
  for (const k of Object.keys((post && post.counters) || {})) {
    const d = (post.counters[k] || 0) - (preMetrics.counters[k] || 0);
    if (d !== 0) deltas.push([k, d]);
  }
  deltas.sort((a, b) => b[1] - a[1]);

  console.log('[ADMIN] deltas de contadores (pós − pré):');
  if (!deltas.length) {
    console.log('[ADMIN]   (nenhum contador mudou)');
  } else {
    for (const [k, d] of deltas) console.log(`[ADMIN]   ${d >= 0 ? '+' : ''}${d}  ${k}`);
  }

  console.log('[ADMIN] latências médias (pre → post):');
  for (const k of ['avgProxyMs', 'avgEventIngestMs', 'avgRecommendationMs', 'avgTrendingMs']) {
    const pre = preMetrics.latency && preMetrics.latency[k];
    const pos = post.latency && post.latency[k];
    if (pre === undefined || pos === undefined) continue;
    console.log(`[ADMIN]   ${k.padEnd(26)} ${pre} → ${pos} ms`);
  }
}

// ── Execução ───────────────────────────────────────────────────
const stats = new Map();
let inflight = 0;
let startedAt = performance.now();
let finished = false;

function stat(name) {
  if (!stats.has(name)) stats.set(name, { n: 0, ok: 0, lat: [], status: {} });
  return stats.get(name);
}

function oneRequest(route) {
  const { method, path } = route.build();
  const u = new URL(BASE + path);
  const headers = { 'User-Agent': 'sventv-load-test/1.0' };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  if (COOKIE) headers.Cookie = `sessionToken=${COOKIE}`;
  const t0 = performance.now();

  const req = http.request(u, { method, headers }, (res) => {
    res.resume();
    res.on('end', () => {
      const lat = performance.now() - t0;
      const s = stat(route.name);
      s.n += 1;
      s.lat.push(lat);
      s.status[res.statusCode] = (s.status[res.statusCode] || 0) + 1;
      if (res.statusCode >= 200 && res.statusCode < 300) s.ok += 1;
      inflight -= 1;
      schedule();
    });
  });
  req.on('error', () => {
    const s = stat(route.name);
    s.n += 1;
    s.lat.push(0);
    s.status.ERR = (s.status.ERR || 0) + 1;
    inflight -= 1;
    schedule();
  });
  req.end();
}

function schedule() {
  if (finished) return;
  while (inflight < CONCURRENCY) {
    inflight += 1;
    oneRequest(ROUTES[Math.floor(Math.random() * ROUTES.length)]);
  }
}

function pct(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return Math.round(sorted[idx]);
}

function summary(label) {
  const lat = [];
  let ok = 0;
  for (const s of stats.values()) {
    ok += s.ok;
    for (const l of s.lat) lat.push(l);
  }
  lat.sort((a, b) => a - b);
  const el = (performance.now() - startedAt) / 1000;
  console.log(
    `${label} n=${lat.length} ok=${ok} rps=${(lat.length / Math.max(1, el)).toFixed(1)} ` +
    `p50=${pct(lat, 0.5)}ms p90=${pct(lat, 0.9)}ms p95=${pct(lat, 0.95)}ms p99=${pct(lat, 0.99)}ms ` +
    `erro%=${((lat.length - ok) / Math.max(1, lat.length) * 100).toFixed(1)}`
  );
}

console.log(`🏁 carga base=${BASE} concorrência=${CONCURRENCY} duração=${DURATION_MS / 1000}s token=${TOKEN ? 'yes' : 'no'} cookie=${COOKIE ? 'yes' : 'no'} admin_cookie=${ADMIN_COOKIE ? 'yes' : 'no'}`);

(async () => {
  // Snapshot pré-carga (só quando admin-cookie válido de sessão admin).
  if (ADMIN_HEADERS) {
    const m = await fetchJson('/api/admin/metrics', ADMIN_HEADERS);
    if (m.status === 200 && m.json && m.json.data) {
      preMetrics = m.json.data;
    } else {
      console.warn(`⚠ admin-cookie fornecido, mas /api/admin/metrics respondeu ${m.status} — deltas administrativos pulados (cookie precisa ser sessão de ADMIN; /metrics NÃO aceita API token).`);
    }
  }

  schedule();

  const timer = setInterval(() => summary('[parcial]'), INTERVAL_MS);
  setTimeout(() => {
    finished = true;
    clearInterval(timer);
    const wait = setInterval(async () => {
      if (inflight === 0) {
        clearInterval(wait);
        summary('[FINAL]');
        for (const [name, s] of stats) {
          const st = Object.entries(s.status).map(([k, v]) => `${k}:${v}`).join(' ');
          console.log(`  ${name.padEnd(12)} n=${String(s.n).padStart(5)} err=${String(s.n - s.ok).padStart(4)} [${st}]`);
        }
        await printAdminMetricsDiff();
        process.exit(0);
      }
    }, 200);
  }, DURATION_MS);
})();