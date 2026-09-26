'use strict';

/**
 * FASE 4 — Lote 3 (channelController):
 *  - getAllChannels: ETag na forma compacta (sem paginação). 304 com
 *    If-None-Match válido; nenhum ETag quando há ?page=&limit=; o valor
 *    muda quando a revisão do M3U ou um estado administrativo muda;
 *  - streamProxy: SSRF_BLOCKED NUNCA reporta falha de fonte
 *    (`reportResult(..., false)`) — a negativa vem da segurança, não da
 *    origem; falha de rede real continua reportando (path de failover).
 *
 * Fakes via require.cache (mesmo padrão de admin-bulk-controller.test.js):
 * M3U, ChannelHealth, ChannelState e streamLimiter (evita sockets/DB/Redis).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');

const M3U_PATH = require.resolve('../src/services/m3uService');
const HEALTH_PATH = require.resolve('../src/services/channelHealthService');
const STATE_PATH = require.resolve('../src/services/channelStateService');
const LIMITER_PATH = require.resolve('../src/middlewares/streamLimiter');

const channelStore = [];
const m3uVector = { version: 0 };
const healthCalls = [];
const stateMap = new Map();

class FakeM3U {
  getAllChannels() { return channelStore; }
  getChannelById(id) { return channelStore.find((c) => c.id === id) || null; }
  getVersion() { return m3uVector.version; }
  ensureLoaded() { return Promise.resolve(); }
}
FakeM3U._shared = null;
FakeM3U.getShared = () => { if (!FakeM3U._shared) FakeM3U._shared = new FakeM3U(); return FakeM3U._shared; };

class FakeHealth {
  reportResult(channelId, url, ok) { healthCalls.push({ channelId, url, ok }); }
  resolveSourceUrls(ch) { return (ch && [ch.url || ch.primaryUrl].filter(Boolean)) || []; }
  resolveActiveUrl(ch) { return (ch && (ch.url || ch.primaryUrl)) || null; }
  getStatuses() { return []; }
  getFailoverInfo() { return null; }
  async checkChannelById() { return { ok: false, checkedAt: null, activeSource: 'primary', primary: null, backup: null }; }
  async checkAllChannels() { return undefined; }
  startAutoChecks() {}
  stopAutoChecks() {}
  async ensureLoaded() { return 0; }
}
FakeHealth._shared = null;
FakeHealth.getShared = () => { if (!FakeHealth._shared) FakeHealth._shared = new FakeHealth(); return FakeHealth._shared; };

class FakeState {
  async get(id) { return stateMap.has(id) ? stateMap.get(id).state : 'live'; }
  set(id, state, opts = {}) {
    const entry = {
      state,
      reason: opts.reason || '',
      setBy: opts.actor || null,
      updatedAt: new Date().toISOString(),
    };
    stateMap.set(id, entry);
    return { prevState: 'live', state, reason: entry.reason, updatedAt: entry.updatedAt };
  }
  all() { return [...stateMap.entries()].map(([id, e]) => ({ id, ...e })); }
  ensureLoaded() { return Promise.resolve(0); }
  peek(id) { return stateMap.has(id) ? stateMap.get(id).state : 'live'; }
}
FakeState._shared = null;
FakeState.getShared = () => { if (!FakeState._shared) FakeState._shared = new FakeState(); return FakeState._shared; };

// `acquireSlot` devolve um LEASE (não boolean) para que o release desfaz
// exatamente o backend que concedeu a vaga. O stub reflete esse contrato.
const LIMITER_STUB = {
  acquireSlot: async () => ({ backend: 'mem', key: 'u:test' }),
  releaseSlot: async () => {},
  keyFor: (req) => (req && req.user && req.user.id) || 'ip:test',
  ACTIVE_DEFAULT: 3,
};

for (const [p, mod] of [
  [M3U_PATH, FakeM3U],
  [HEALTH_PATH, FakeHealth],
  [STATE_PATH, FakeState],
  [LIMITER_PATH, LIMITER_STUB],
]) {
  require.cache[p] = { id: p, filename: p, loaded: true, exports: mod };
}

const ChannelController = require('../src/controllers/channelController');
const controller = new ChannelController();

function spyRes() {
  const res = {
    statusCode: null,
    jsonBody: null,
    ended: false,
    sent: false,
    headers: {},
  };
  res.status = function (code) { this.statusCode = code; return this; };
  res.json = function (body) { this.jsonBody = body; this.sent = true; return this; };
  res.end = function () { this.ended = true; return this; };
  res.setHeader = function (k, v) { this.headers[k] = v; };
  res.once = function () { return this; };
  return res;
}

function req(overrides = {}) {
  return {
    params: {},
    query: {},
    headers: {},
    body: {},
    ip: '203.0.113.9',
    ...overrides,
  };
}

function withAxios(mock, fn) {
  const original = axios.get;
  axios.get = mock;
  return Promise.resolve()
    .then(fn)
    .finally(() => { axios.get = original; });
}

// ─── getAllChannels: ETag ──────────────────────────────────────

test('getAllChannels compacto: define ETag + no-cache e responde 304 com If-None-Match válido', async () => {
  channelStore.length = 0;
  stateMap.clear();
  m3uVector.version = 1;
  channelStore.push(
    { id: 'ch-a_00000001_0', name: 'Canal A', url: 'http://93.184.216.34/a.m3u8', source: 'x.m3u' },
    { id: 'ch-b_00000002_1', name: 'Canal B', url: 'http://93.184.216.34/b.ts', source: 'x.m3u' },
  );

  const first = spyRes();
  controller.getAllChannels(req(), first);

  assert.equal(first.statusCode, 200);
  assert.equal(first.sent, true);
  assert.ok(first.headers.ETag, 'ETag presente na resposta compacta');
  assert.equal(first.headers['Cache-Control'], 'no-cache');
  assert.equal(first.jsonBody.data.channels.length, 2);
  // Campos upstream nunca vazam
  assert.equal('url' in first.jsonBody.data.channels[0], false);
  assert.equal('source' in first.jsonBody.data.channels[0], false);

  // Cliente revalida com o ETag anterior → 304, sem corpo.
  const cached = first.headers.ETag;
  const second = spyRes();
  controller.getAllChannels(req({ headers: { 'if-none-match': cached } }), second);

  assert.equal(second.statusCode, 304);
  assert.equal(second.sent, false);
  assert.equal(second.ended, true);
});

test('getAllChannels compacto: ETag muda quando um estado administrativo muda', async () => {
  channelStore.length = 0;
  stateMap.clear();
  m3uVector.version = 2;
  channelStore.push({ id: 'ch-x_00000009_0', name: 'Canal X', url: 'http://93.184.216.34/x.m3u8', source: 'x.m3u' });

  const a = spyRes();
  controller.getAllChannels(req(), a);
  const etagBefore = a.headers.ETag;

  stateMap.set('ch-x_00000009_0', { state: 'maintenance', reason: 'teste', setBy: 'root', updatedAt: new Date().toISOString() });

  const b = spyRes();
  controller.getAllChannels(req({ headers: { 'if-none-match': etagBefore } }), b);

  assert.equal(b.statusCode, 200, 'estado mudou → recurso mudou → 200');
  assert.ok(b.headers.ETag !== etagBefore, 'ETag invalidador quando o estado muda');
});

test('getAllChannels compacto: versão do M3U também invalida o ETag', async () => {
  channelStore.length = 0;
  stateMap.clear();
  m3uVector.version = 3;
  channelStore.push({ id: 'ch-y_00000003_0', name: 'Canal Y', url: 'http://93.184.216.34/y.m3u8', source: 'x.m3u' });

  const a = spyRes();
  controller.getAllChannels(req(), a);
  const etagBefore = a.headers.ETag;

  m3uVector.version = 4; // reload da playlist hipotético

  const b = spyRes();
  controller.getAllChannels(req({ headers: { 'if-none-match': etagBefore } }), b);
  assert.equal(b.statusCode, 200);
  assert.ok(b.headers.ETag !== etagBefore);
});

test('getAllChannels paginado: NÃO emite ETag', async () => {
  channelStore.length = 0;
  stateMap.clear();
  m3uVector.version = 5;
  for (let i = 0; i < 3; i++) {
    channelStore.push({ id: `ch-p_${i}`, name: `Canal ${i}`, url: 'http://93.184.216.34/p.ts', source: 'x.m3u' });
  }

  const res = spyRes();
  controller.getAllChannels(
    req({ query: { page: '1', limit: '2' }, headers: { 'if-none-match': '"qualquer"' } }),
    res,
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers.ETag, undefined, 'paginação é cacheável por página → sem ETag global');
  assert.equal(res.jsonBody.data.pagination.page, 1);
  assert.equal(res.jsonBody.data.channels.length, 2);
});

// ─── streamProxy: SSRF_BLOCKED nunca infla failCount ───────────

test('streamProxy: SSRF_BLOCKED em redirect NÃO chama reportResult(false) e responde 403', async () => {
  channelStore.length = 0;
  stateMap.clear();
  healthCalls.length = 0;
  channelStore.push({
    id: 'ch-s_00000007_0',
    name: 'Canal S',
    url: 'http://93.184.216.34/s.m3u8', // público → guarda inicial passa
    source: 'x.m3u',
  });

  // 302 para link-local: a recurssão do redirect bate na guarda → SSRF_BLOCKED.
  const mockAxios = async () => ({
    status: 302,
    headers: { location: 'http://169.254.169.254/redir.m3u8' },
    data: { destroy: () => {} },
  });

  await withAxios(mockAxios, async () => {
    const res = spyRes();
    await controller.streamProxy(req({ params: { id: 'ch-s_00000007_0' } }), res);

    assert.equal(res.statusCode, 403);
    assert.equal(res.jsonBody.message, 'Destino de stream bloqueado');
    assert.equal(healthCalls.length, 0, 'SSRF_BLOCKED nunca é reportado como falha de fonte');
  });
});

test('streamProxy: falha de rede real mantém reportResult(false) (failover preservado)', async () => {
  channelStore.length = 0;
  stateMap.clear();
  healthCalls.length = 0;
  channelStore.push({
    id: 'ch-n_00000008_0',
    name: 'Canal N',
    url: 'http://93.184.216.34/n.m3u8',
    source: 'x.m3u',
  });

  const mockAxios = async () => {
    const e = new Error('conn ref');
    e.code = 'ECONNREFUSED';
    throw e;
  };

  await withAxios(mockAxios, async () => {
    const res = spyRes();
    await controller.streamProxy(req({ params: { id: 'ch-n_00000008_0' } }), res);

    assert.equal(res.statusCode, 502);
    const reported = healthCalls.filter((c) => c.channelId === 'ch-n_00000008_0');
    assert.equal(reported.length, 1);
    assert.equal(reported[0].ok, false);
  });
});