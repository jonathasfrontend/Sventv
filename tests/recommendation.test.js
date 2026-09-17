'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { scoreRecommendations, buildAffinity, getRecommendations } = require('../src/services/recommendationService');

const now = new Date();

const history = [
  {
    channelId: 'sports-1',
    channelName: 'Sport TV',
    channelCategory: 'Esporte',
    playCount: 4,
    sessionsCount: 4,
    totalWatchMs: 4 * 3600000,
    lastPlayedAt: now,
  },
  {
    channelId: 'sports-2',
    channelName: 'ESPN',
    channelCategory: 'Esporte;Variedades',
    playCount: 2,
    sessionsCount: 2,
    totalWatchMs: 2 * 3600000,
    lastPlayedAt: now,
  },
];

const catalog = [
  { id: 'sports-1', name: 'Sport TV', category: 'Esporte', format: 'HLS', availability: 'Disponível', quality: '1080p' },
  { id: 'sports-3', name: 'Fox Sports', category: 'Esporte', format: 'HLS', availability: 'Disponível' },
  { id: 'sports-4', name: 'Offline Sports', category: 'Esporte', format: 'HLS', availability: 'Disponível' },
  { id: 'sports-5', name: 'Geo Spot', category: 'Esporte', format: 'HLS', availability: 'Bloqueado geograficamente' },
  { id: 'movies-1', name: 'Tela Quente', category: 'Filmes', format: 'HLS', availability: 'Disponível' },
  { id: 'news-1', name: 'Globo News', category: 'Notícias', format: 'HTTP', availability: 'Disponível' },
];

test('buildAffinity agrega afinidade por categoria e topWatch', () => {
  const { categoryAffinity, topWatch } = buildAffinity(history);
  assert.ok(categoryAffinity.get('Esporte') > 0);
  assert.ok(categoryAffinity.has('Variedades'));
  assert.equal(topWatch.get('sports-1').playCount, 4);
  assert.equal(topWatch.get('sports-1').totalWatchMs, 4 * 3600000);
});

test('scoreRecommendations: recomenda, exclui usuário-assistido e offline e geo-bloqueado', () => {
  const statusOk = new Map([['sports-4', false]]);
  const result = scoreRecommendations(history, catalog, statusOk, 5);

  const ids = result.items.map((i) => i.channel.id);
  assert.ok(ids.includes('sports-3'), 'deve recomendar canal de esporte não assistido');
  assert.ok(!ids.includes('sports-1'), 'não deve recomendar canal já assistido');
  assert.ok(!ids.includes('sports-4'), 'não deve recomendar canal offline');
  assert.ok(!ids.includes('sports-5'), 'não deve recomendar canal com restrição geográfica');
  assert.ok(!ids.includes('movies-1'), 'canal sem afinidade não entra');
  assert.ok(!ids.includes('news-1'), 'canal de formato não-HLS não entra (proxy HLS)');

  assert.ok(result.reasons['sports-3'], 'deve haver razão para o recomendado');
  assert.equal(result.reasons['sports-3'].category, 'Esporte');
  assert.ok(result.reasons['sports-3'].text.includes('Sport TV'));
  assert.ok(result.reasons['sports-3'].text.includes('Esporte'));

  assert.ok(result.summary.topCategories.includes('Esporte'));
  assert.ok(result.summary.mostWatched[0].id === 'sports-1');
});

test('scoreRecommendations é determinístico e respeita o limite', () => {
  const r1 = scoreRecommendations(history, catalog, new Map(), 3);
  const r2 = scoreRecommendations(history, catalog, new Map(), 3);
  assert.deepEqual(r1.items.map((i) => i.channel.id), r2.items.map((i) => i.channel.id));
  assert.ok(r1.items.length <= 3);
});

test('scoreRecommendations sem histórico retorna vazio', () => {
  const result = scoreRecommendations([], catalog, new Map(), 5);
  assert.deepEqual(result.items, []);
  assert.equal(result.summary, null);
});

test('getRecommendations usa cache por usuário (TTL) e injeta providers', async () => {
  const ctx = {
    historyProvider: async () => history,
    getAllChannels: () => catalog,
    getStatusMap: () => new Map(),
  };

  const first = await getRecommendations('user-A', ctx);
  assert.equal(first.fromCache, false);
  assert.ok(first.items.some((i) => i.id === 'sports-3'));
  assert.ok('url' in first.items[0] === false, 'item público nunca expõe url');

  const second = await getRecommendations('user-A', ctx);
  assert.equal(second.fromCache, true);

  const other = await getRecommendations('user-B', ctx);
  assert.equal(other.fromCache, false, 'cache é por usuário, não global');
});