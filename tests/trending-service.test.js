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
  svc.sections = { movies: [], series: [], channels: [] };
  svc.lastFetchedAt = 0;
  svc.lastError = null;
  svc._fetchPromise = null;
  return svc;
}

// ── Normalização de filmes/séries/canais ──────────────────────

test('normalizeMovie expõe só metadados públicos e escolhe o poster', async () => {
  const svc = makeService();
  svc._postGraphQL = async () => ({
    data: {
        trecResults: {
          movies: [
            {
              id: 'm1',
              nowContentId: 'nc1',
              title: 'Filme X',
              rating: { description: '12 anos' },
              runTime: 'PT1H30M',
              description: { short: 'Uma sinopse.' },
              assets: [
                { ratio: '16:9', url: 'https://img.example/wide.jpg', category: 'Backdrop' },
                { ratio: '2:3', url: 'https://img.example/poster.jpg', category: 'Poster' },
              ],
            },
            { id: 'm2', title: 'Sem assets e sem extras' },
          ],
        },
      },
  });

  const movies = await svc._fetchMovies();
  assert.equal(movies.length, 2);

  const m1 = movies[0];
  assert.equal(m1.id, 'm1');
  assert.equal(m1.nowContentId, 'nc1');
  assert.equal(m1.title, 'Filme X');
  assert.equal(m1.rating, '12 anos');
  assert.equal(m1.runTime, '1h 30min');
  assert.equal(m1.description, 'Uma sinopse.');
  assert.equal(m1.image, 'https://img.example/poster.jpg'); // poster tem prioridade
  assert.equal(m1.images.length, 2);
  assert.ok(!('url' in m1) || !m1.url, 'vácuo de URL de stream na saída');

  const m2 = movies[1];
  assert.equal(m2.runTime, '');
  assert.equal(m2.image, '');
});

test('normalizeSeries usa o mesmo shape público', async () => {
  const svc = makeService();
  svc._postGraphQL = async () => ({
    data: {
        recResults: {
          series: [
            {
              id: 's1',
              title: 'Série Y',
              rating: { description: '10' },
              runTime: 42,
              description: { short: 'Sinopse.' },
              assets: [{ ratio: '16:9', url: 'https://img.example/wide.jpg', category: 'Backdrop' }],
            },
          ],
        },
      },
  });

  const series = await svc._fetchSeries();
  assert.equal(series.length, 1);
  assert.equal(series[0].title, 'Série Y');
  assert.equal(series[0].rating, '10');
  assert.equal(series[0].runTime, '42min'); // número → minutos
  assert.equal(series[0].image, 'https://img.example/wide.jpg');
});

test('normalizeChannel vira logo + metadados públicos dos canais ao vivo', async () => {
  const svc = makeService();
  svc._postGraphQL = async () => ({
    data: {
        trecResults: {
          liveCatalogs: [
            {
              id: 'c1',
              name: 'Canal Esporte',
              shortName: 'C1',
              description: 'Cobertura ao vivo.',
              genreCategory: 'Esporte',
              channelName: 'Canal Esporte 1',
              genre: 'Futebol',
              assets: [{ url: 'https://img.example/c1.png', assetId: 'a1' }],
            },
          ],
          position: 1,
          totalCount: 10,
        },
      },
  });

  const channels = await svc._fetchChannels();
  assert.equal(channels.length, 1);
  assert.equal(channels[0].id, 'c1');
  assert.equal(channels[0].name, 'Canal Esporte');
  assert.equal(channels[0].genre, 'Futebol');
  assert.equal(channels[0].genreCategory, 'Esporte');
  assert.equal(channels[0].logo, 'https://img.example/c1.png');
  assert.ok(!channels[0].assets, 'assets brutos não vazam');
});

test('sem asset de poster, a imagem de fallback é a primeira (backdrop/qualquer)', async () => {
  const svc = makeService();
  svc._postGraphQL = async () => ({
    data: {
        trecResults: {
          movies: [
            {
              id: 'm1',
              title: 'Filme',
              assets: [
                { ratio: '16:9', url: 'https://img.example/wide.jpg', category: 'Backdrop' },
                { ratio: '1:1', url: 'https://img.example/square.jpg', category: 'Square' },
              ],
            },
          ],
        },
      },
  });
  const movies = await svc._fetchMovies();
  assert.equal(movies[0].image, 'https://img.example/wide.jpg');
});

test('formato de duração sem ISO e sem numérico passa como texto', async () => {
  const svc = makeService();
  svc._postGraphQL = async () => ({
    data: {
        trecResults: {
          movies: [{ id: 'm1', title: 'Filme', runTime: '2 temporadas' }],
        },
      },
  });
  const movies = await svc._fetchMovies();
  assert.equal(movies[0].runTime, '2 temporadas');
});

// ── fetch + commit (fail-open) ────────────────────────────────

test('fetchAndParse populou as três seções quando todas têm sucesso', async () => {
  const svc = makeService();
  svc._fetchMovies = async () => [{ id: 'm1', title: 'Filme' }];
  svc._fetchSeries = async () => [{ id: 's1', title: 'Série' }];
  svc._fetchChannels = async () => [{ id: 'c1', name: 'Canal' }];

  const result = await svc.fetchAndParse();
  assert.equal(result.movies, 'ok');
  assert.equal(result.series, 'ok');
  assert.equal(result.channels, 'ok');
  assert.equal(svc.sections.movies.length, 1);
  assert.equal(svc.sections.series.length, 1);
  assert.equal(svc.sections.channels.length, 1);
  assert.equal(svc.lastError, null);
  assert.ok(svc.hasData());
});

test('fetchAndParse mantém cache anterior por seção quando uma falha (fail-open)', async () => {
  const svc = makeService();
  svc._fetchMovies = async () => [{ id: 'm1', title: 'Filme' }];
  svc._fetchSeries = async () => [{ id: 's1', title: 'Série' }];
  svc._fetchChannels = async () => [{ id: 'c1', name: 'Canal' }];
  await svc.fetchAndParse();
  const before = svc.sections.movies.slice();

  svc._fetchSeries = async () => { throw new Error('conteudo sensivel nunca deve vazar'); };
  const result = await svc.fetchAndParse();

  assert.equal(result.series, 'HTTP');
  assert.equal(result.movies, 'ok');
  assert.equal(svc.sections.series[0].id, 's1'); // cache anterior preservado
  assert.deepEqual(svc.sections.movies, before);
  assert.equal(svc.lastError.type, 'HTTP');
  assert.ok(!JSON.stringify(svc.lastError).includes('sensivel'));
  assert.ok(!JSON.stringify(svc.lastError).includes('catalog.example'));
});

test('fetchAndParse mapeia timeout para TIMEOUT sem derrubar', async () => {
  const svc = makeService();
  svc._fetchMovies = async () => { throw Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }); };
  svc._fetchSeries = async () => [{ id: 's1', title: 'Série' }];
  svc._fetchChannels = async () => [{ id: 'c1', name: 'Canal' }];

  const result = await svc.fetchAndParse();
  assert.equal(result.movies, 'TIMEOUT');
  assert.equal(result.series, 'ok');
  assert.equal(svc.hasData(), true);
});

test('fetchAndParse com todas as seções falhando não renova cache nem derruba', async () => {
  const svc = makeService();
  svc._fetchMovies = async () => { throw Object.assign(new Error('bloqueado'), { code: 'SSRF_BLOCKED' }); };
  svc._fetchSeries = async () => { throw new Error('rede'); };
  svc._fetchChannels = async () => { throw new Error('rede'); };

  const before = svc.lastFetchedAt;
  const result = await svc.fetchAndParse();
  assert.equal(result.movies, 'SSRF_BLOCKED');
  assert.equal(result.series, 'HTTP');
  assert.equal(result.channels, 'HTTP');
  assert.equal(svc.lastFetchedAt, before); // última renovação não avança
  assert.equal(svc.hasData(), false);
});

test('serviço desabilitado (TRENDING_ENABLED=false) não faz fetch e vira no-op', async () => {
  const svc = makeService();
  svc.enabled = false;
  svc._fetchMovies = async () => { throw new Error('não deve ser chamado'); };
  svc._fetchSeries = async () => { throw new Error('não deve ser chamado'); };
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
  svc._fetchMovies = async () => { calls += 1; return [{ id: 'm1', title: 'Filme' }]; };
  svc._fetchSeries = async () => [{ id: 's1', title: 'Série' }];
  svc._fetchChannels = async () => [{ id: 'c1', name: 'Canal' }];

  await Promise.all([svc.ensureLoaded(), svc.ensureLoaded()]);
  assert.equal(calls, 1); // segunda chamada reusou a promise em andamento
  assert.equal(svc.hasData(), true);
});

test('getSnapshot devolve as três seções + totais (shape da dashboard)', async () => {
  const svc = makeService();
  svc.sections.movies = [{ id: 'm1', title: 'Filme' }];
  svc.sections.series = [{ id: 's1', title: 'Série' }];
  svc.sections.channels = [{ id: 'c1', name: 'Canal' }];
  svc.lastFetchedAt = Date.now();

  const snap = svc.getSnapshot({ force: true });
  assert.equal(snap.total.movies, 1);
  assert.equal(snap.total.series, 1);
  assert.equal(snap.total.channels, 1);
  assert.equal(snap.movies[0].id, 'm1');
  assert.equal(snap.cached, true);
  assert.ok(snap.fetchedAt);
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

test('GET /api/trending sem token -> 401 (rota existe, protegida)', async () => {
  setDatabaseConnected(true);
  const express = require('express');
  const trendingRoutes = require('../src/routes/trendingRoutes');

  const app = express();
  app.use('/api/trending', trendingRoutes);
  const server = await startServer(app);
  try {
    const res = await fetch(`${baseUrl(server)}/api/trending`);
    assert.equal(res.status, 401);
    const json = await res.json();
    assert.equal(json.success, false);
  } finally {
    await closeServer(server);
  }
});

test('GET /api/trending/movies sem token -> 401 (mesma guarda)', async () => {
  setDatabaseConnected(true);
  const express = require('express');
  const trendingRoutes = require('../src/routes/trendingRoutes');

  const app = express();
  app.use('/api/trending', trendingRoutes);
  const server = await startServer(app);
  try {
    const res = await fetch(`${baseUrl(server)}/api/trending/movies`);
    assert.equal(res.status, 401);
  } finally {
    await closeServer(server);
  }
});