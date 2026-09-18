'use strict';

/**
 * Busca combinada server-side (GET /api/epg/search):
 *  - epgService.search: canais vêm SÓ da M3U oficial; programas só quando há
 *    match EPG; token de horário resolvido via tzOffsetMinutes (tests em UTC);
 *    limites defensivos; ordenação por horário; nunca vaza EPG_URL/stream.
 *  - epgController.search: q inválido → 422; EPG desabilitado → 200 vazio;
 *    saída pública (toPublicChannel sem url/source); métrica guideSearches.
 *  - rota protegida: sem token → 401 (qualquer termo).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { setDatabaseConnected } = require('../src/utils/dbState');
const { snapshot } = require('../src/utils/metrics');

const EPGService = require('../src/services/epgService');

// ── makeService (igual epg-service.test.js) ───────────────────

function makeService({ m3uChannels = [] } = {}) {
  const svc = Object.create(EPGService.prototype);
  svc.m3uService = {
    getAllChannels: () => m3uChannels,
    getChannelById: (id) => m3uChannels.find((c) => c.id === id) || null,
  };
  svc.epgUrl = 'http://epg.example/xmltv.xml';
  svc.enabled = true;
  svc.cacheTtlMs = 1800000;
  svc.fetchTimeoutMs = 10000;
  svc.channels = [];
  svc.programmes = [];
  svc.programmesByChannel = new Map();
  svc.matchMap = new Map();
  svc.matchEntries = [];
  svc.lastFetchedAt = 0;
  svc.lastError = null;
  svc._fetchPromise = null;
  return svc;
}

const loadXml = (svc, xml) => {
  const parsed = svc.parseXml(xml);
  svc.channels = parsed.channels;
  svc.programmes = parsed.programmes;
  svc.programmesByChannel = svc._groupByChannel(parsed.programmes);
  svc.lastFetchedAt = Date.now();
  svc.lastError = null;
  svc._rebuildMatching();
  return parsed;
};

const XMLTV = `
<tv generator-info-name="test">
  <channel id="g1"><display-name lang="pt">Globo</display-name></channel>
  <channel id="g2"><display-name lang="pt">SBT</display-name></channel>
  <channel id="g3"><display-name lang="pt">Sem Par</display-name></channel>
  <programme start="20260918150000 +0000" stop="20260918160000 +0000" channel="g1">
    <title lang="pt">Futebol na Globo</title><category>Esporte</category>
  </programme>
  <programme start="20260918153000 +0000" stop="20260918163000 +0000" channel="g1">
    <title lang="pt">Jornal Hoje</title>
  </programme>
  <programme start="20260918200000 +0000" stop="20260918210000 +0000" channel="g2">
    <title lang="pt">Novela do SBT</title><category>Drama</category>
  </programme>
</tv>`;

const M3U_CHANNELS = [
  { id: 'a1', cleanName: 'Globo HD', name: 'Globo HD', category: 'Aberta', logo: '', url: 'http://upstream.invalido/hls.m3u8', source: 'x' },
  { id: 'a2', cleanName: 'SBT', name: 'SBT', category: 'Aberta', logo: '', url: '', source: 'x' },
];

// ── epgService.search ─────────────────────────────────────────

test('search: texto casa canais da M3U e programas dos canais com match EPG', () => {
  const svc = makeService({ m3uChannels: M3U_CHANNELS });
  loadXml(svc, XMLTV);

  const out = svc.search('futebol', { tzOffsetMinutes: 0 });
  assert.deepEqual(out.channels.map((c) => c.id), []);
  assert.equal(out.programmes.length, 1);
  assert.equal(out.programmes[0].title, 'Futebol na Globo');
  assert.equal(out.programmes[0].channelId, 'a1');
  assert.equal(out.programmes[0].start, Date.UTC(2026, 8, 18, 15, 0, 0));
});

test('search: "globo" casa o canal M3U mesmo sem menção nos programas', () => {
  const svc = makeService({ m3uChannels: M3U_CHANNELS });
  loadXml(svc, XMLTV);
  const out = svc.search('globo', { tzOffsetMinutes: 0 });
  assert.deepEqual(out.channels.map((c) => c.id), ['a1']);
  assert.equal(out.programmes.length, 2, 'programas do canal com match também entram');
});

test('search: programa de canal EPG sem correspondente na M3U nunca participa', () => {
  const svc = makeService({ m3uChannels: M3U_CHANNELS });
  loadXml(svc, XMLTV);
  const out = svc.search('par', { tzOffsetMinutes: 0 });
  assert.equal(out.channels.length, 0);
  assert.equal(out.programmes.length, 0);
  assert.ok(JSON.stringify(out).includes('par') === false || out.programmes.length === 0);
});

test('search: token de horário "15h" (UTC) casa a hora inteira; "15:30" o minuto exato', () => {
  const svc = makeService({ m3uChannels: M3U_CHANNELS });
  loadXml(svc, XMLTV);

  const loose = svc.search('15h', { tzOffsetMinutes: 0 });
  assert.equal(loose.programmes.length, 2); // Futebol (15:00) + Jornal (15:30)

  const exact = svc.search('15:30', { tzOffsetMinutes: 0 });
  assert.equal(exact.programmes.length, 1);
  assert.equal(exact.programmes[0].title, 'Jornal Hoje');
});

test('search: "novela 20h" combina texto E horário', () => {
  const svc = makeService({ m3uChannels: M3U_CHANNELS });
  loadXml(svc, XMLTV);
  const out = svc.search('novela 20h', { tzOffsetMinutes: 0 });
  assert.equal(out.programmes.length, 1);
  assert.equal(out.programmes[0].title, 'Novela do SBT');
  assert.equal(out.programmes[0].channelId, 'a2');
});

test('search: limite de programas (limitProgrammes=1) e cap máximo respeitados', () => {
  const svc = makeService({ m3uChannels: M3U_CHANNELS });
  loadXml(svc, XMLTV);
  const limited = svc.search('', { limitProgrammes: 1, tzOffsetMinutes: 0 });
  assert.equal(limited.programmes.length, 1);
  assert.ok(limited.matchedProgrammes >= limited.programmes.length);
  const capped = svc.search('', { limitChannels: 999, limitProgrammes: 999, tzOffsetMinutes: 0 });
  assert.ok(capped.programmes.length <= 200);
});

test('search: sem match → arrays vazios (nunca 500)', () => {
  const svc = makeService({ m3uChannels: M3U_CHANNELS });
  loadXml(svc, XMLTV);
  const out = svc.search('zumbilândia inexistente', { tzOffsetMinutes: 0 });
  assert.deepEqual(out.channels, []);
  assert.deepEqual(out.programmes, []);
});

test('search: nunca expõe EPG_URL nem upstream (saída é só metadados públicos)', () => {
  const svc = makeService({ m3uChannels: M3U_CHANNELS });
  loadXml(svc, XMLTV);
  const out = JSON.stringify(svc.search('', { tzOffsetMinutes: 0 }));
  assert.ok(!out.includes('epg.example'), 'não vaza host do EPG');
  assert.ok(!out.includes('upstream.invalido'), 'não vaza URL de stream');
  assert.ok(!out.includes('epgUrl') && !out.includes('EPG_URL'));
});

// ── epgController.search ──────────────────────────────────────

const M3U_PATH = require.resolve('../src/services/m3uService');
class FakeM3UService {
  static getShared() {
    if (!FakeM3UService._shared) FakeM3UService._shared = new FakeM3UService();
    return FakeM3UService._shared;
  }
  constructor() { this.channels = M3U_CHANNELS; }
  getChannelById(id) { return this.channels.find((c) => c.id === id) || null; }
  getAllChannels() { return this.channels; }
  async ensureLoaded() { return this; }
}
FakeM3UService._shared = null;
require.cache[M3U_PATH] = { id: M3U_PATH, filename: M3U_PATH, loaded: true, exports: FakeM3UService };

const EPG_PATH = require.resolve('../src/services/epgService');
const EPG_CONTROLLER_PATH = require.resolve('../src/controllers/epgController');

function withEpgServiceStub(impl, fn) {
  require.cache[EPG_PATH] = { id: EPG_PATH, filename: EPG_PATH, loaded: true, exports: impl };
  // O controller captura EPGService no primeiro require; remover o cache dele
  // aqui é OBRIGATÓRIO para que `new EPGController()` use o stub corrente.
  delete require.cache[EPG_CONTROLLER_PATH];
  try { return fn(); } finally {
    delete require.cache[EPG_PATH];
    delete require.cache[EPG_CONTROLLER_PATH];
  }
}

test('search (controller): 422 para query vazia/sem conteúdo', () => {
  withEpgServiceStub({
    getShared: () => ({ isEnabled: () => true }),
  }, () => {
    const EPGController = require('../src/controllers/epgController');
    const ctl = new EPGController();
    let body = null; let status = 0;
    const res = { status(c) { status = c; return this; }, json(p) { body = p; return this; } };
    return (async () => {
      await ctl.search({ query: { q: '   ' } }, res);
      assert.equal(status, 422);
      assert.equal(body.success, false);

      await ctl.search({ query: {} }, res);
      assert.equal(status, 422);
    })();
  });
});

test('search (controller): EPG desabilitado → 200 com arrays vazios (fail-open)', async () => {
  await withEpgServiceStub({
    getShared: () => ({ isEnabled: () => false }),
  }, async () => {
    const EPGController = require('../src/controllers/epgController');
    const ctl = new EPGController();
    let body = null; let status = 0;
    const res = { status(c) { status = c; return this; }, json(p) { body = p; return this; } };
    await ctl.search({ query: { q: 'x' } }, res);
    assert.equal(status, 200);
    assert.deepEqual(body.data.channels, []);
    assert.deepEqual(body.data.programmes, []);
  });
});

test('search (controller): saída sanitizada (sem url/source) + enriquecimento de canal', async () => {
  const svc = makeService({ m3uChannels: M3U_CHANNELS });
  loadXml(svc, XMLTV);
  await withEpgServiceStub({
    getShared: () => ({
      isEnabled: () => true,
      ensureLoaded: async () => {},
      search: (q, o) => svc.search(q, o),
      getEpgChannelId: (id) => svc.matchMap.get(id) || null,
    }),
  }, async () => {
    const EPGController = require('../src/controllers/epgController');
    const ctl = new EPGController();
    let body = null; let status = 0;
    const res = { status(c) { status = c; return this; }, json(p) { body = p; return this; } };
    await ctl.search({ query: { q: 'globo', tz: '0' } }, res);
    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.equal(body.data.channels[0].id, 'a1');
    assert.ok(!('url' in body.data.channels[0]), 'url nunca sai em busca do guia');
    assert.ok(!('source' in body.data.channels[0]));
    assert.equal(body.data.channels[0].epgChannelId, 'g1');
    const p = body.data.programmes.find((x) => x.title === 'Futebol na Globo');
    assert.equal(p.channelId, 'a1');
    assert.equal(p.channelName, 'Globo HD');
    assert.ok(snapshot().counters.guideSearches >= 1);
  });
});

test('search (controller): tz fora de faixa é clampado (−840..840)', async () => {
  const svc = makeService({ m3uChannels: M3U_CHANNELS });
  loadXml(svc, XMLTV);
  let seenTz = null;
  await withEpgServiceStub({
    getShared: () => ({
      isEnabled: () => true,
      ensureLoaded: async () => {},
      search: (q, o) => { seenTz = o.tzOffsetMinutes; return { channels: [], programmes: [] }; },
      getEpgChannelId: () => null,
    }),
  }, async () => {
    const EPGController = require('../src/controllers/epgController');
    const ctl = new EPGController();
    const res = { status() { return this; }, json() { return this; } };
    await ctl.search({ query: { q: 'x', tz: '99999' } }, res);
    assert.equal(seenTz, 840);
  });
});

// ── Rota protegida ────────────────────────────────────────────

function startServer(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}
function closeServer(server) { return new Promise((resolve) => server.close(resolve)); }
function baseUrl(server) { return `http://127.0.0.1:${server.address().port}`; }

test('GET /api/epg/search sem token → 401 (rota existe, registrada antes de /:channelId)', async () => {
  setDatabaseConnected(true);
  const express = require('express');
  const epgRoutes = require('../src/routes/epgRoutes');
  const app = express();
  app.use('/api/epg', epgRoutes);
  const server = await startServer(app);
  try {
    const res = await fetch(`${baseUrl(server)}/api/epg/search?q=futebol`);
    assert.equal(res.status, 401);
  } finally {
    await closeServer(server);
  }
});