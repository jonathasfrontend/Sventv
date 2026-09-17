'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const EPGService = require('../src/services/epgService');
const { setDatabaseConnected } = require('../src/utils/dbState');

// ── Helpers ───────────────────────────────────────────────────

// Instância sem I/O nem estado global: evita o singleton e o fetch real.
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
  <channel id="g2"><display-name lang="pt">SBT FHD</display-name></channel>
  <channel id="g3"><display-name lang="pt">Canal Sem Equivalente</display-name></channel>
  <programme start="20260915100000 +0000" stop="20260915120000 +0000" channel="g1">
    <title lang="pt">Filme da Tarde</title><desc>Sinopse filme</desc><category>Filme</category>
  </programme>
  <programme start="20260915120000 +0000" stop="20260915130000 +0000" channel="g1">
    <title lang="pt">Jornal Hoje</title>
  </programme>
  <programme start="20260915090000 +0000" stop="20260915110000 +0000" channel="g2">
    <title lang="pt">Programa da Manhã</title>
  </programme>
</tv>`;

const M3U_CHANNELS = [
  { id: 'a1', cleanName: 'Globo HD', name: 'Globo HD' },
  { id: 'a2', cleanName: 'SBT', name: 'SBT' },
];

// ── parseXml / parseXmltvTime ─────────────────────────────────

test('parseXml resolve canais e programas (atributos + titulos)', () => {
  const svc = makeService();
  const { channels, programmes } = svc.parseXml(XMLTV);

  assert.equal(channels.length, 3);
  assert.equal(channels[0].id, 'g1');
  assert.equal(channels[0].displayName, 'Globo');

  assert.equal(programmes.length, 3);
  const p0 = programmes.find((p) => p.channel === 'g1' && p.title === 'Filme da Tarde');
  assert.equal(p0.start, Date.UTC(2026, 8, 15, 10, 0, 0));
  assert.equal(p0.stop, Date.UTC(2026, 8, 15, 12, 0, 0));
  assert.equal(p0.subtitle, '');
  assert.equal(p0.description, 'Sinopse filme');
  assert.deepEqual(p0.categories, ['Filme']);
});

test('parseXml descarta programa incompleto (sem stop/title/tempo inválido)', () => {
  const svc = makeService();
  const bad = `
<tv>
  <channel id="x"><display-name>X</display-name></channel>
  <programme channel="x" start="20260915100000 +0000"><title>sem stop</title></programme>
  <programme channel="x" start="20260915100000 +0000" stop="20260915110000 +0000"></programme>
  <programme channel="x" start="abc" stop="20260915110000 +0000"><title>tempo ruim</title></programme>
</tv>`;
  const { programmes } = svc.parseXml(bad);
  assert.equal(programmes.length, 0);
});

test('parseXmltvTime respeita offset de fuso (UTC corretamente)', () => {
  const svc = makeService();
  assert.equal(svc.parseXmltvTime('20260915150000 +0000'), Date.UTC(2026, 8, 15, 15, 0, 0));
  assert.equal(svc.parseXmltvTime('20260915150000 -0300'), Date.UTC(2026, 8, 15, 18, 0, 0));
  assert.equal(svc.parseXmltvTime('20260915150000 +0530'), Date.UTC(2026, 8, 15, 9, 30, 0));
  assert.equal(svc.parseXmltvTime('nao-eh-data'), null);
});

// ── normalização / índice ─────────────────────────────────────

test('normalizeName remove acentos, sufixos de qualidade, parenteses e &', () => {
  const svc = makeService();
  assert.equal(svc.normalizeName('Globo HD'), 'globo');
  assert.equal(svc.normalizeName('SÃO PAULO FHD'), 'sao paulo');
  assert.equal(svc.normalizeName('Discovery Channel (BR)'), 'discovery channel');
  assert.equal(svc.normalizeName('ESPN & Fox 4k'), 'espn e fox');
  assert.equal(svc.normalizeName('  Ultra  [Não 24h] '), 'ultra');
});

test('buildNameIndex normaliza e mantém a primeira ocorrência', () => {
  const svc = makeService();
  const index = svc.buildNameIndex([
    { id: 'a1', cleanName: 'Globo HD' },
    { id: 'a2', cleanName: 'Globo' },
    { id: 'a3', cleanName: 'TNT Series' },
  ]);
  assert.equal(index.get('globo'), 'a1');
  assert.equal(index.get('tnt series'), 'a3');
});

// ── matching ──────────────────────────────────────────────────

test('matchEpgChannels casa por nome direto e descarta sem equivalente', () => {
  const svc = makeService();
  const nameIndex = svc.buildNameIndex(M3U_CHANNELS);
  const epgChannels = [
    { id: 'g1', displayName: 'Globo' },
    { id: 'g2', displayName: 'SBT FHD' },
    { id: 'g3', displayName: 'Canal Sem Equivalente' },
  ];
  const matchMap = svc.matchEpgChannels(epgChannels, nameIndex, {});

  assert.deepEqual([...matchMap.entries()], [['a1', 'g1'], ['a2', 'g2']]);
});

test('matchEpgChannels usa epgAliases quando o nome nao bate', () => {
  const svc = makeService();
  const nameIndex = svc.buildNameIndex(M3U_CHANNELS);
  const epgChannels = [{ id: 'pre', displayName: 'TeleCine Prime' }];
  const aliases = { pre: 'Telecine Premium' };
  const matchMap = svc.matchEpgChannels(epgChannels, nameIndex, aliases);

  assert.equal(matchMap.size, 0); // 'telecine premium' nao existe na M3U de teste

  const nameIndex2 = svc.buildNameIndex([{ id: 'a2', cleanName: 'Telecine Premium' }]);
  const matchMap2 = svc.matchEpgChannels(epgChannels, nameIndex2, aliases);
  assert.deepEqual([...matchMap2.entries()], [['a2', 'pre']]);
});

test('matchEpgChannels nunca casa via id do XMLTV e o primeiro EPG vence', () => {
  const svc = makeService();
  const nameIndex = svc.buildNameIndex(M3U_CHANNELS);
  // mesmo displayName em dois ids → só o primeiro internalId é mapeado
  const matchMap = svc.matchEpgChannels(
    [{ id: 'x1', displayName: 'Globo' }, { id: 'x2', displayName: 'Globo' }],
    nameIndex,
    {}
  );
  assert.deepEqual([...matchMap.entries()], [['a1', 'x1']]);
});

// ── rebuild / getAllMatched / getGuide / getNowNext ───────────

test('_rebuildMatching popula matchMap + getAllMatched ordenado', () => {
  const svc = makeService({ m3uChannels: M3U_CHANNELS });
  svc.channels = [
    { id: 'g1', displayName: 'Globo' },
    { id: 'g2', displayName: 'SBT FHD' },
    { id: 'g3', displayName: 'Sem par' },
  ];
  svc._rebuildMatching();

  const matched = svc.getAllMatched();
  assert.equal(matched.length, 2);
  assert.deepEqual(matched.map((m) => m.channelId), ['a1', 'a2']); // ordenado por displayName (Globo < SBT FHD)
  assert.equal(matched.find((m) => m.channelId === 'a1').epgChannelId, 'g1');
});

test('getGuide devolve toda a janela do XML (ordenada por start)', () => {
  const svc = makeService({ m3uChannels: M3U_CHANNELS });
  loadXml(svc, XMLTV);
  const guide = svc.getGuide('a1');
  assert.equal(guide.length, 2);
  assert.equal(guide[0].title, 'Filme da Tarde');
  assert.equal(guide[1].title, 'Jornal Hoje');
});

test('getNowNext com now injetado (atual + próximo)', () => {
  const svc = makeService({ m3uChannels: M3U_CHANNELS });
  loadXml(svc, XMLTV);
  const now = Date.UTC(2026, 8, 15, 11, 0, 0); // 11h UTC — dentro de 10h→12h
  const { current, next } = svc.getNowNext('a1', now);
  assert.equal(current.title, 'Filme da Tarde');
  assert.equal(next.title, 'Jornal Hoje');
});

test('getNowNext devolve next quando agora está antes do início (buraco)', () => {
  const svc = makeService({ m3uChannels: M3U_CHANNELS });
  loadXml(svc, XMLTV);

  const now = Date.UTC(2026, 8, 15, 8, 0, 0); // antes do programa das 9h
  const g2 = svc.getNowNext('a2', now);
  assert.equal(g2.current, null);
  assert.equal(g2.next.title, 'Programa da Manhã');
});

test('getNowNext retorna null para canal sem match', () => {
  const svc = makeService({ m3uChannels: M3U_CHANNELS });
  loadXml(svc, XMLTV);
  assert.equal(svc.getNowNext('nao-existe', Date.now()), null);
});

// ── fail-open / cache ─────────────────────────────────────────

test('fetchAndParse atualiza cache e reconstrói matching em sucesso', async () => {
  const svc = makeService({ m3uChannels: M3U_CHANNELS });
  svc._fetchXml = async () => XMLTV;
  const result = await svc.fetchAndParse();

  assert.equal(result.channels, 3);
  assert.equal(result.programmes, 3);
  assert.equal(svc.hasData(), true);
  assert.deepEqual([...svc.matchMap.entries()], [['a1', 'g1'], ['a2', 'g2']]);
});

test('fetchAndParse mantém cache anterior quando o fetch falha (fail-open)', async () => {
  const svc = makeService({ m3uChannels: M3U_CHANNELS });
  svc._fetchXml = async () => XMLTV;
  await svc.fetchAndParse(); // popula cache
  const before = svc.programmes.length;
  const beforeMap = svc.matchMap;

  svc._fetchXml = async () => { throw new Error('conteudo sensivel nunca deve aparecer'); };
  const result = await svc.fetchAndParse();

  assert.equal(result.error, 'HTTP');
  assert.equal(result.cached, true);
  assert.equal(svc.programmes.length, before);
  assert.equal(svc.matchMap, beforeMap);
  assert.equal(svc.lastError.type, 'HTTP');
  assert.ok(!JSON.stringify(svc.lastError).includes('conteudo sensivel'));
  assert.ok(!JSON.stringify(svc.lastError).includes('epg.example'));
});

test('fetchAndParse mapeia timeout para TIMEOUT sem derrubar', async () => {
  const svc = makeService({ m3uChannels: M3U_CHANNELS });
  svc._fetchXml = async () => { throw Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }); };
  const result = await svc.fetchAndParse();
  assert.equal(result.error, 'TIMEOUT');
  assert.equal(result.cached, false);
  assert.equal(svc.hasData(), false);
});

test('fetchAndParse com SSRF_BLOCKED também é fail-open (nunca failover)', async () => {
  const svc = makeService({ m3uChannels: M3U_CHANNELS });
  svc._fetchXml = async () => { throw Object.assign(new Error('bloqueado'), { code: 'SSRF_BLOCKED' }); };
  const result = await svc.fetchAndParse();
  assert.equal(result.error, 'SSRF_BLOCKED');
  assert.equal(result.cached, false);
});

test('serviço desabilitado (EPG_ENABLED=false) não faz fetch e vira no-op', async () => {
  const svc = makeService();
  svc.enabled = false;
  svc._fetchXml = async () => { throw new Error('não deve ser chamado'); };
  const result = await svc.fetchAndParse();
  assert.equal(result.enabled, false);

  const loaded = await svc.ensureLoaded();
  assert.equal(loaded, svc);
  assert.equal(svc._fetchPromise, null);
});

test('ensureLoaded dispara fetch quando cache vazio e reusa promise em andamento', async () => {
  const svc = makeService({ m3uChannels: M3U_CHANNELS });
  let calls = 0;
  svc._fetchXml = async () => { calls += 1; return XMLTV; };

  await Promise.all([svc.ensureLoaded(), svc.ensureLoaded()]);
  assert.equal(calls, 1); // segunda chamada reusou a promise em andamento
  assert.equal(svc.hasData(), true);
});

// ── getGrid (janela do grid) ──────────────────────────────────

test('getGrid recorta programas à janela e marca isLive pelos horários originais', () => {
  const svc = makeService({ m3uChannels: M3U_CHANNELS });
  loadXml(svc, XMLTV);

  // Janela 10:30→12:30: 'Globo' começa com "Filme da Tarde" (10:00→12:00)
  // JÁ EM CURSO (célula recortada de 10:30) e termina com "Jornal Hoje"
  // (12:00→13:00) recortado a 12:30.
  const from = Date.UTC(2026, 8, 15, 10, 30, 0);
  const to = Date.UTC(2026, 8, 15, 12, 30, 0);
  const now = Date.UTC(2026, 8, 15, 11, 0, 0);

  const grid = svc.getGrid(from, to, now);
  assert.equal(grid.from, from);
  assert.equal(grid.to, to);
  assert.equal(grid.now, now);

  const row = grid.channels.find((c) => c.channelId === 'a1');
  assert.ok(row, 'canal com match apareceu');
  assert.equal(row.programmes.length, 2);

  const filme = row.programmes.find((p) => p.title === 'Filme da Tarde');
  // Recortado à janela: começa em 10:30 (o original é 10:00)
  assert.equal(filme.start, from);
  assert.equal(filme.stop, Date.UTC(2026, 8, 15, 12, 0, 0));
  // isLive olha o original (10:00→12:00 contém now 11:00) → true
  assert.equal(filme.isLive, true);

  const jornal = row.programmes.find((p) => p.title === 'Jornal Hoje');
  assert.equal(jornal.start, Date.UTC(2026, 8, 15, 12, 0, 0));
  assert.equal(jornal.stop, Date.UTC(2026, 8, 15, 12, 30, 0));
  assert.equal(jornal.isLive, false);
});

test('getGrid inclui TODOS os canais da M3U — sem match EPG aparece com programmes vazio', () => {
  const svc = makeService({
    m3uChannels: [
      ...M3U_CHANNELS,
      { id: 'a3', cleanName: 'Canal Sem EPG', name: 'Canal Sem EPG' },
    ],
  });
  loadXml(svc, XMLTV);

  const from = Date.UTC(2026, 8, 15, 10, 30, 0);
  const to = Date.UTC(2026, 8, 15, 12, 30, 0);
  const grid = svc.getGrid(from, to, from);

  assert.equal(grid.total, 3); // 2 com match + 1 sem match, todos na guia
  const row = grid.channels.find((c) => c.channelId === 'a3');
  assert.ok(row, 'canal M3U sem EPG não é descartado do grid');
  assert.equal(row.epgChannelId, null);
  assert.deepEqual(row.programmes, []);
  assert.equal(row.displayName, 'Canal Sem EPG');
});

test('getGrid descarta programas fora da janela e canais sem programação zero', () => {
  const svc = makeService({ m3uChannels: M3U_CHANNELS });
  loadXml(svc, XMLTV);

  // Janela bem antes do primeiro programa do 'SBT' (09:00) → busca vazia.
  const from = Date.UTC(2026, 8, 15, 0, 0, 0);
  const to = Date.UTC(2026, 8, 15, 5, 0, 0);
  const grid = svc.getGrid(from, to, from);

  assert.equal(grid.total, 2); // ambos com match, mas programação vazia na janela
  for (const row of grid.channels) assert.deepEqual(row.programmes, []);
  assert.equal(grid.channels.find((c) => c.channelId === 'a2').displayName, 'SBT FHD');
});

// ── Janela do player (embutida no HTML) ───────────────────────

test('getPlayerWindow devolve só o que intersecta a janela, sem recortar horários reais', () => {
  const svc = makeService({ m3uChannels: M3U_CHANNELS });
  loadXml(svc, XMLTV);

  // Janela "agora − 1h → agora + 12h" simulada em volta do Jornal Hoje.
  const now = Date.UTC(2026, 8, 15, 13, 0, 0);       // 13:00 UTC
  const from = now - 60 * 60 * 1000;                 // 12:00 UTC
  const to = now + 12 * 60 * 60 * 1000;              // 01:00 UTC (day 16)

  const out = svc.getPlayerWindow('a1', from, to);

  // Programas de 'g1' (Globo HD): 10:00→12:00 (Filme) e 12:00→13:00 (Jornal).
  // O Jornal intersecta a janela a partir de 12:00; o Filme terminou em 12:00
  // (p.stop <= from) → fora.
  assert.equal(out.length, 1);
  assert.equal(out[0].title, 'Jornal Hoje');
  // Horários ORIGINAIS preservados (sem clip de start) para progresso correto.
  assert.equal(out[0].start, Date.UTC(2026, 8, 15, 12, 0, 0));
  assert.equal(out[0].stop, Date.UTC(2026, 8, 15, 13, 0, 0));
  assert.equal(out[0].description, '');
});

test('getPlayerWindow mantém start original de programa iniciado ANTES da janela (progresso real)', () => {
  const svc = makeService({ m3uChannels: M3U_CHANNELS });
  loadXml(svc, XMLTV);

  // Programa Filme da Tarde (10:00→12:00) está no ar em 11:30, mas começa
  // ANTES do from da janela (11:00). O player precisa do start REAL (10:00)
  // para calcular o progresso, não do recorte.
  const now = Date.UTC(2026, 8, 15, 11, 30, 0);
  const from = now - 60 * 60 * 1000; // 10:30 → clip seria start=10:30
  const to = now + 12 * 60 * 60 * 1000;

  const out = svc.getPlayerWindow('a1', from, to);
  const filme = out.find((p) => p.title === 'Filme da Tarde');
  assert.ok(filme, 'programa corrente intersecta a janela');
  assert.equal(filme.start, Date.UTC(2026, 8, 15, 10, 0, 0)); // NÃO clipado
  assert.equal(filme.stop, Date.UTC(2026, 8, 15, 12, 0, 0));  // NÃO clipado
});

test('getPlayerWindow ordena por start ASC e canal sem match devolve []', () => {
  const svc = makeService({ m3uChannels: M3U_CHANNELS });
  loadXml(svc, XMLTV);

  const now = Date.UTC(2026, 8, 15, 9, 0, 0);
  const from = now - 60 * 60 * 1000;
  const to = now + 12 * 60 * 60 * 1000;

  const sbt = svc.getPlayerWindow('a2', from, to); // 09:00→11:00 Programa da Manhã
  assert.equal(sbt.length, 1);

  const noMatch = svc.getPlayerWindow('id-inexistente', from, to);
  assert.deepEqual(noMatch, []);
});

test('getPlayerWindow nunca expõe EPG_URL (saída é só start/stop/título/descrição)', () => {
  const svc = makeService({ m3uChannels: M3U_CHANNELS });
  loadXml(svc, XMLTV);

  const now = Date.UTC(2026, 8, 15, 11, 0, 0);
  const out = svc.getPlayerWindow('a1', now - 60 * 60 * 1000, now + 12 * 60 * 60 * 1000);
  const serialized = JSON.stringify(out);
  assert.ok(!serialized.includes('epg.example'), 'não vaza host do EPG');
  assert.ok(!serialized.includes('epgUrl') && !serialized.includes('EPG_URL'), 'não vaza chave de config');
});

// ── Relatório admin ───────────────────────────────────────────

test('getUnmatchedReport separa EPG sem match e M3U sem EPG', () => {
  const svc = makeService({ m3uChannels: M3U_CHANNELS });
  loadXml(svc, XMLTV);

  const report = svc.getUnmatchedReport();
  assert.equal(report.totalM3u, 2);
  assert.equal(report.matched, 2);
  const epgAlone = report.epgWithoutMatch.find((e) => e.epgChannelId === 'g3');
  assert.equal(epgAlone ? true : false, true);
  assert.equal(report.m3uWithoutEpg.length, 0);
});

// ── Rotas (proteção de autenticação) ──────────────────────────

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}
function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function baseUrl(server) {
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

test('GET /api/epg sem token -> 401 (rota existe, protegida)', async () => {
  setDatabaseConnected(true);
  const express = require('express');
  const epgRoutes = require('../src/routes/epgRoutes');

  const app = express();
  app.use('/api/epg', epgRoutes);
  const server = await startServer(app);
  try {
    const res = await fetch(`${baseUrl(server)}/api/epg`);
    assert.equal(res.status, 401);
    const json = await res.json();
    assert.equal(json.success, false);
  } finally {
    await closeServer(server);
  }
});

test('GET /api/epg/:channelId sem token -> 401 (mesma guarda)', async () => {
  setDatabaseConnected(true);
  const express = require('express');
  const epgRoutes = require('../src/routes/epgRoutes');

  const app = express();
  app.use('/api/epg', epgRoutes);
  const server = await startServer(app);
  try {
    const res = await fetch(`${baseUrl(server)}/api/epg/qualquer-id`);
    assert.equal(res.status, 401);
  } finally {
    await closeServer(server);
  }
});

test('GET /api/epg/grid sem token -> 401 (mesma guarda)', async () => {
  setDatabaseConnected(true);
  const express = require('express');
  const epgRoutes = require('../src/routes/epgRoutes');

  const app = express();
  app.use('/api/epg', epgRoutes);
  const server = await startServer(app);
  try {
    const res = await fetch(`${baseUrl(server)}/api/epg/grid`);
    assert.equal(res.status, 401);
  } finally {
    await closeServer(server);
  }
});

test('GET /api/epg/grid com janela inválida -> 422 com errors[]', async () => {
  const EPGController = require('../src/controllers/epgController');
  const ctl = new EPGController();
  // Guarda contra I/O: isEnabled e ensureLoaded stubbed antes de validar.
  ctl.epgService = { isEnabled: () => true, ensureLoaded: async () => {} };

  let status = 0;
  let body = null;
  const res = {
    status(code) { status = code; return this; },
    json(payload) { body = payload; return this; },
  };

  const call = (query) => ctl.gridGuide({ query }, res);

  await call({ from: 'nao-eh-numero', to: '123' });
  assert.equal(status, 422);
  assert.deepEqual(body.errors, ['"from" deve ser um timestamp em milissegundos (epoch)']);
  assert.equal(body.success, false);

  await call({ from: '1000', to: '999' });
  assert.equal(status, 422);
  assert.ok(body.errors.some((e) => e.includes('anterior a "to"')));

  await call({ from: '0', to: String((7 * 24 + 1) * 3600 * 1000) });
  assert.equal(status, 422);
  assert.ok(body.errors.some((e) => e.includes('janela máxima')));
});

test('GET /api/epg/grid com janela omitida usa padrão (agora − 2h → +25h)', async () => {
  const EPGController = require('../src/controllers/epgController');
  const ctl = new EPGController();
  const HOUR = 60 * 60 * 1000;
  const before = Date.now();
  ctl.epgService = {
    isEnabled: () => true,
    ensureLoaded: async () => {},
    getGrid: (from, to, now) => ({ from, to, now, total: 0, channels: [] }),
  };
  ctl.m3uService = { getChannelById: () => null };

  let body = null;
  const res = {
    status() { return this; },
    json(payload) { body = payload; return this; },
  };
  await ctl.gridGuide({ query: {} }, res);

  const after = Date.now();
  const fromMs = Date.parse(body.data.from);
  const toMs = Date.parse(body.data.to);
  // from = hora cheia atual − 2h (≤ before, ≥ hora-cheia de before − 2h)
  assert.ok(Math.floor(before / HOUR) * HOUR - 2 * HOUR === fromMs
         || Math.floor(before / HOUR) * HOUR - 2 * HOUR === fromMs + HOUR);
  assert.equal(toMs - fromMs, 27 * HOUR);
  assert.ok(body.data.now >= new Date(before).toISOString() && body.data.now <= new Date(after).toISOString());
});

test('GET /api/admin/epg/unmatched sem sessão -> 401 (slot admin)', async () => {
  setDatabaseConnected(true);
  // Replica o wiring real de adminRoutes (router.use(requireSessionAuth,
  // requireRole('admin'))) SEM importar o adminController — que criaria um
  // ChannelHealthService com timers vivos e penduraria o runner de testes.
  const express = require('express');
  const { requireSessionAuth, requireRole } = require('../src/middlewares/auth');

  const router = express.Router();
  router.use(requireSessionAuth, requireRole('admin'));
  router.get('/epg/unmatched', (_req, res) => res.json({ ok: true }));

  const app = express();
  app.use('/api/admin', router);
  const server = await startServer(app);
  try {
    const res = await fetch(`${baseUrl(server)}/api/admin/epg/unmatched`);
    assert.equal(res.status, 401);
  } finally {
    await closeServer(server);
  }
});