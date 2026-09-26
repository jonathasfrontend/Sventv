'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const TrendingService = require('../src/services/trendingService');
const { setDatabaseConnected } = require('../src/utils/dbState');

// ── Helpers ───────────────────────────────────────────────────

// Instância sem I/O nem estado global: evita o singleton e o fetch real.
function makeService() {
  const svc = Object.create(TrendingService.prototype);
  svc.apiUrl = 'https://catalog.example/graphql';
  svc.enabled = true;
  svc.cacheTtlMs = 1800000;
  svc.fetchTimeoutMs = 10000;
  svc.channels = [];
  svc.lastFetchedAt = 0;
  svc.lastError = null;
  svc._fetchPromise = null;
  return svc;
}

// Assets reais do provedor: 4 paisagem (212x119 … 408x230) + 5 retrato ~2:3
// (129x194 … 360x540), na ordem em que a API devolve.
function realAssets(base = 'https://getcdn.nowonline.com.br/images_epg') {
  return [
    { url: `${base}/212_119/0001_epg.jpg`, assetId: '0001_epg212x119' },
    { url: `${base}/255_143/0001_epg.jpg`, assetId: '0001_epg255x143' },
    { url: `${base}/312_176/0001_epg.jpg`, assetId: '0001_epg312x176' },
    { url: `${base}/408_230/0001_epg.jpg`, assetId: '0001_epg408x230' },
    { url: `${base}/129_194/0001.jpg`, assetId: '0001_epg129x194' },
    { url: `${base}/200_300/0001.jpg`, assetId: '0001_epg200x300' },
    { url: `${base}/264_396/0001.jpg`, assetId: '0001_epg264x396' },
    { url: `${base}/357_536/0001.jpg`, assetId: '0001_epg357x536' },
    { url: `${base}/360_540/0001.jpg`, assetId: '0001_epg360x540' },
  ];
}

// ── Normalização dos canais ao vivo ───────────────────────────

test('normalizeChannel expõe só metadados públicos dos canais ao vivo', async () => {
  const svc = makeService();
  svc._postGraphQL = async () => ({
    data: {
      trecResults: {
        liveCatalogs: [
          {
            id: 'c1',
            name: 'Jornal GloboNews',
            shortName: '',
            description: 'Cobertura ao vivo.',
            genreCategory: '6',
            channelName: 'GLOBONEWS',
            genre: 'Jornalismo Informativo',
            assets: [{ url: 'https://img.example/c1.jpg', assetId: 'c1_epg360x540' }],
          },
          { id: 'c2', name: 'Sem assets' },
        ],
      },
    },
  });

  const channels = await svc._fetchChannels();
  assert.equal(channels.length, 2);

  const c1 = channels[0];
  assert.equal(c1.id, 'c1');
  assert.equal(c1.name, 'Jornal GloboNews');
  assert.equal(c1.channelName, 'GLOBONEWS');
  assert.equal(c1.genre, 'Jornalismo Informativo');
  assert.equal(c1.genreCategory, '6');
  assert.equal(c1.image, 'https://img.example/c1.jpg');
  assert.ok(!c1.assets, 'assets brutos não vazam');
  assert.ok(!('url' in c1) || !c1.url, 'vácuo de URL de stream na saída');

  assert.equal(channels[1].image, '');
});

test('a imagem escolhida é o pôster retrato ~2:3, não a faixa paisagem', async () => {
  const svc = makeService();
  svc._postGraphQL = async () => ({
    data: { trecResults: { liveCatalogs: [{ id: 'c1', name: 'P', assets: realAssets() }] } },
  });

  const [c1] = await svc._fetchChannels();
  // A primeira entrada do array é a paisagem 212x119; escolher o primeiro
  // asset deixava o card vertical com uma fatia minúscula.
  assert.equal(c1.image, 'https://getcdn.nowonline.com.br/images_epg/360_540/0001.jpg');
  assert.ok(!c1.image.includes('212_119'));
});

test('entre pôsters ~2:3 escolhe o de maior resolução', async () => {
  const svc = makeService();
  const assets = [
    { url: 'https://img.example/212_119.jpg', assetId: 'a_epg212x119' },
    { url: 'https://img.example/129_194.jpg', assetId: 'a_epg129x194' },
    { url: 'https://img.example/200_300.jpg', assetId: 'a_epg200x300' },
    { url: 'https://img.example/264_396.jpg', assetId: 'a_epg264x396' },
  ];
  svc._postGraphQL = async () => ({
    data: { trecResults: { liveCatalogs: [{ id: 'c1', name: 'P', assets }] } },
  });

  const [c1] = await svc._fetchChannels();
  assert.equal(c1.image, 'https://img.example/264_396.jpg');
});

test('sem retrato disponível, usa a paisagem; sem metadados de tamanho, o primeiro', async () => {
  const svc = makeService();
  svc._postGraphQL = async () => ({
    data: {
      trecResults: {
        liveCatalogs: [
          {
            id: 'c1',
            name: 'Só paisagem',
            assets: [
              { url: 'https://img.example/212_119.jpg', assetId: 'a_epg212x119' },
              { url: 'https://img.example/408_230.jpg', assetId: 'a_epg408x230' },
            ],
          },
          {
            id: 'c2',
            name: 'Sem tamanho',
            assets: [{ url: 'https://img.example/qualquer.jpg' }, { url: '' }, { url: 'https://img.example/segunda.jpg' }],
          },
        ],
      },
    },
  });

  const channels = await svc._fetchChannels();
  // 408x230 é a paisagem maior (0,6 de diferença para 16:9) → melhor nitidez.
  assert.equal(channels[0].image, 'https://img.example/408_230.jpg');
  // Sem hint de tamanho, ignora asset sem url e usa o primeiro válido.
  assert.equal(channels[1].image, 'https://img.example/qualquer.jpg');
});

test('o tamanho também é lido do path da URL quando o assetId não tem hint', async () => {
  const svc = makeService();
  svc._postGraphQL = async () => ({
    data: {
      trecResults: {
        liveCatalogs: [
          {
            id: 'c1',
            name: 'Path',
            assets: [
              { url: 'https://cdn.example/images_epg/212_119/1.jpg' },
              { url: 'https://cdn.example/images_epg/360_540/1.jpg' },
            ],
          },
        ],
      },
    },
  });

  const [c1] = await svc._fetchChannels();
  assert.equal(c1.image, 'https://cdn.example/images_epg/360_540/1.jpg');
});

test('item inválido no meio da lista não derruba a seção (fail-open pontual)', async () => {
  const svc = makeService();
  svc._postGraphQL = async () => ({
    data: {
      trecResults: {
        liveCatalogs: [null, { id: 'c1', name: 'Válido' }, { name: 'sem id' }],
      },
    },
  });

  const channels = await svc._fetchChannels();
  assert.equal(channels.length, 1);
  assert.equal(channels[0].id, 'c1');
});

// ── fetch + commit (fail-open) ────────────────────────────────

test('fetchAndParse populou os canais ao vivo', async () => {
  const svc = makeService();
  svc._fetchChannels = async () => [{ id: 'c1', name: 'Canal' }];

  const result = await svc.fetchAndParse();
  assert.equal(result.enabled, true);
  assert.equal(result.channels, 'ok');
  assert.equal(svc.channels.length, 1);
  assert.equal(svc.lastError, null);
  assert.ok(svc.hasData());
});

test('fetchAndParse mantém o cache anterior quando o fetch falha (fail-open)', async () => {
  const svc = makeService();
  svc._fetchChannels = async () => [{ id: 'c1', name: 'Canal' }];
  await svc.fetchAndParse();
  const before = svc.channels.slice();
  const beforeAt = svc.lastFetchedAt;

  svc._fetchChannels = async () => { throw new Error('conteudo sensivel nunca deve vazar'); };
  const result = await svc.fetchAndParse();

  assert.equal(result.channels, 'HTTP');
  assert.deepEqual(svc.channels, before);
  assert.equal(svc.lastFetchedAt, beforeAt); // TTL não renova em falha
  assert.equal(svc.lastError.type, 'HTTP');
  assert.ok(!JSON.stringify(svc.lastError).includes('sensivel'));
  assert.ok(!JSON.stringify(svc.lastError).includes('catalog.example'));
});

test('fetchAndParse mapeia timeout para TIMEOUT sem derrubar', async () => {
  const svc = makeService();
  svc._fetchChannels = async () => { throw Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }); };

  const result = await svc.fetchAndParse();
  assert.equal(result.channels, 'TIMEOUT');
  assert.equal(svc.hasData(), false);
});

test('fetchAndParse com falha nunca renova o cache nem vaza o host', async () => {
  const svc = makeService();
  svc._fetchChannels = async () => { throw Object.assign(new Error('bloqueado'), { code: 'SSRF_BLOCKED' }); };

  const before = svc.lastFetchedAt;
  const result = await svc.fetchAndParse();
  assert.equal(result.channels, 'SSRF_BLOCKED');
  assert.equal(svc.lastFetchedAt, before);
  assert.equal(svc.hasData(), false);
});

test('serviço desabilitado (TRENDING_ENABLED=false) não faz fetch e vira no-op', async () => {
  const svc = makeService();
  svc.enabled = false;
  svc._fetchChannels = async () => { throw new Error('não deve ser chamado'); };

  const result = await svc.fetchAndParse();
  assert.equal(result.enabled, false);

  const loaded = await svc.ensureLoaded();
  assert.equal(loaded, svc);
  assert.equal(svc._fetchPromise, null);
});

test('ensureLoaded dispara fetch quando cache vazio e reusa promise em andamento', async () => {
  const svc = makeService();
  let calls = 0;
  svc._fetchChannels = async () => { calls += 1; return [{ id: 'c1', name: 'Canal' }]; };

  await Promise.all([svc.ensureLoaded(), svc.ensureLoaded()]);
  assert.equal(calls, 1); // segunda chamada reusou a promise em andamento
  assert.equal(svc.hasData(), true);
});

test('getSnapshot devolve só a seção de canais + totais (shape da dashboard)', async () => {
  const svc = makeService();
  svc.channels = [{ id: 'c1', name: 'Canal' }];
  svc.lastFetchedAt = Date.now();

  const snap = svc.getSnapshot({ force: true });
  assert.equal(snap.total.channels, 1);
  assert.equal(snap.channels[0].id, 'c1');
  assert.equal(snap.cached, true);
  assert.ok(snap.fetchedAt);
  // Filmes/séries foram removidos: nada de chassi fantasma no payload.
  assert.ok(!('movies' in snap));
  assert.ok(!('series' in snap));
  assert.equal(snap.movies, undefined);
  assert.equal(snap.series, undefined);
});

test('getStats não expõe a URL do provedor', () => {
  const svc = makeService();
  const stats = svc.getStats();
  assert.equal(stats.configured, true);
  assert.ok(!JSON.stringify(stats).includes('catalog.example'));
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

async function withApp(fn) {
  setDatabaseConnected(true);
  const express = require('express');
  const trendingRoutes = require('../src/routes/trendingRoutes');

  const app = express();
  app.use('/api/trending', trendingRoutes);
  const server = await startServer(app);
  try {
    return await fn(baseUrl(server));
  } finally {
    await closeServer(server);
  }
}

test('GET /api/trending sem token -> 401 (rota existe, protegida)', async () => {
  await withApp(async (base) => {
    const res = await fetch(`${base}/api/trending`);
    assert.equal(res.status, 401);
    const json = await res.json();
    assert.equal(json.success, false);
  });
});

test('GET /api/trending/channels sem token -> 401 (mesma guarda)', async () => {
  await withApp(async (base) => {
    const res = await fetch(`${base}/api/trending/channels`);
    assert.equal(res.status, 401);
  });
});

test('GET /api/trending/movies e /series não existem mais (404)', async () => {
  await withApp(async (base) => {
    const movies = await fetch(`${base}/api/trending/movies`);
    const series = await fetch(`${base}/api/trending/series`);
    assert.equal(movies.status, 404);
    assert.equal(series.status, 404);
  });
});
