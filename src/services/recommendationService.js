/**
 * SvenTV API — Recommendation Service
 *
 * Motor de recomendação determinístico e explicável (rule-based).
 *
 * Sinais utilizados (apenas dados reais do usuário):
 *  - watch time por canal (totalWatchMs)
 *  - frequência (playCount / sessionsCount)
 *  - recência (lastPlayedAt)
 *  - afinidade por categoria (agregada dos sinais acima)
 *
 * Regras de exclusão:
 *  - canais já assistidos (na história do usuário)
 *  - canais offline (health check)
 *  - canais com disponibilidade "Bloqueado geograficamente" / limitada
 *  - canais que não existem mais no M3U
 *
 * Determinístico: empates resolvidos por nome/ID estáveis. Estrutura
 * permite evolução para content-based / collaborative filtering / ML:
 * basta substituir a função de score mantendo o contrato de saída.
 *
 * Cache: SEMPRE por usuário (chave = userId), com TTL — nunca entre
 * usuários. Vive por lambda (serverless), o que é aceitável: um usuário
 * só é servido pela própria entrada no Map.
 */

'use strict';

const config = require('../config/app');
const { inc, recordRecommendationLatency } = require('../utils/metrics');

const RECENCY_WEIGHT = 1.05; // multiplicador ao quadrado: repetir = mais peso

/**
 * Afinidade por categoria a partir do histórico.
 * @param {object[]} history linhas serializadas de watch_history
 * @returns {{ categoryAffinity: Map<string,number>, topWatch: Map<string, {name:string, playCount:number, sessionsCount:number, totalWatchMs:number, lastPlayedAt:Date}> }}
 */
const buildAffinity = (history) => {
  const categoryAffinity = new Map();
  const topWatch = new Map(); // channelId -> summary

  const recencyFactor = (lastPlayedAt) => {
    const ageDays = Math.max(0, (Date.now() - new Date(lastPlayedAt).getTime()) / 86_400_000);
    return Math.pow(RECENCY_WEIGHT, 30 - Math.min(ageDays, 30)); // 1..~4.3
  };

  for (const row of history) {
    const minutes = (Number(row.totalWatchMs) || 0) / 60000;
    const weight = minutes * 2 + (row.playCount || 0) * 10 + 5;
    const boost = weight * recencyFactor(row.lastPlayedAt);

    topWatch.set(row.channelId, {
      id: row.channelId,
      name: row.channelName || row.channelId,
      playCount: row.playCount || 0,
      sessionsCount: row.sessionsCount || 0,
      totalWatchMs: Number(row.totalWatchMs) || 0,
      lastPlayedAt: row.lastPlayedAt,
    });

    const cats = String(row.channelCategory || '').split(';');
    for (const raw of cats) {
      const cat = raw.trim();
      if (!cat) continue;
      categoryAffinity.set(cat, (categoryAffinity.get(cat) || 0) + boost);
    }
  }
  return { categoryAffinity, topWatch };
};

/**
 * Função pura de scoring (exportada para testes). Determinística.
 * @param {object[]} history linhas serializadas de watch_history
 * @param {object[]} allChannels canais do M3U (objetos internos, com categoria)
 * @param {Map<string, boolean>} statusOk channelId -> online?
 * @param {number} limit quantidade máxima de recomendações
 * @returns {{ items: object[], reasons: object, summary: object|null }}
 */
const scoreRecommendations = (history, allChannels, statusOk = new Map(), limit = 8) => {
  const { categoryAffinity, topWatch } = buildAffinity(history);
  const watchedIds = new Set(history.map((h) => h.channelId));

  if (categoryAffinity.size === 0) return { items: [], reasons: {}, summary: null };

  const topCategories = [...categoryAffinity.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  const topChannelsByCategory = new Map(); // cat -> { id, name, playCount }
  for (const row of history) {
    const cats = String(row.channelCategory || '').split(';');
    for (const raw of cats) {
      const cat = raw.trim();
      if (!cat) continue;
      if (!topChannelsByCategory.has(cat)) {
        topChannelsByCategory.set(cat, {
          id: row.channelId,
          name: row.channelName || row.channelId,
          playCount: row.playCount || 0,
          sessionsCount: row.sessionsCount || 0,
          weight: 0,
        });
      }
      const entry = topChannelsByCategory.get(cat);
      const rowWeight = (Number(row.totalWatchMs) || 0) / 60000 + (row.playCount || 0) * 5;
      if (rowWeight > entry.weight) {
        entry.weight = rowWeight;
        entry.id = row.channelId;
        entry.name = row.channelName || row.channelId;
        entry.playCount = row.playCount || 0;
        entry.sessionsCount = row.sessionsCount || 0;
      }
    }
  }

  const scored = [];
  for (const ch of allChannels) {
    if (!ch || !ch.id) continue;
    if (watchedIds.has(ch.id)) continue; // já assistido
    if (statusOk.has(ch.id) && statusOk.get(ch.id) === false) continue; // offline
    if (ch.availability && ch.availability !== 'Disponível') continue;
    if (ch.format && ch.format !== 'HLS') continue; // preferência HLS (proxy)

    const cats = String(ch.category || '').split(';');
    let score = 0;
    for (const raw of cats) {
      const cat = raw.trim();
      if (!cat) continue;
      score += categoryAffinity.get(cat) || 0;
    }
    if (score <= 0) continue;
    scored.push({ channel: ch, score, cats: cats.map((c) => c.trim()).filter(Boolean) });
  }

  // Determinístico: score desc → nome asc → id asc.
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const na = (a.channel.name || '').toLowerCase();
    const nb = (b.channel.name || '').toLowerCase();
    if (na !== nb) return na.localeCompare(nb);
    return (a.channel.id || '').localeCompare(b.channel.id || '');
  });

  const top = scored.slice(0, Math.min(Math.max(Number(limit) || 8, 1), 20));

  const reasons = {};
  const bestTopChannel = topChannelsByCategory.values().next();
  for (const item of top) {
    // A categoria com maior afinidade dentre as categorias do canal.
    let bestCat = item.cats[0];
    let bestAff = 0;
    for (const cat of item.cats) {
      const aff = categoryAffinity.get(cat) || 0;
      if (aff > bestAff) {
        bestAff = aff;
        bestCat = cat;
      }
    }
    const example = topChannelsByCategory.get(bestCat);
    const label = example
      ? `Você assistiu "${example.name}" ${example.playCount || example.sessionsCount} vez(es) e costuma assistir à categoria "${bestCat}". Por isso, recomendamos "${item.channel.name}".`
      : `Você costuma assistir à categoria "${bestCat}". Por isso, recomendamos "${item.channel.name}".`;
    reasons[item.channel.id] = {
      category: bestCat,
      score: Math.round(item.score * 100) / 100,
      example: example ? { name: example.name, playCount: example.playCount, sessionsCount: example.sessionsCount } : null,
      text: label,
    };
  }

  const summary = {
    topCategories: topCategories.map(([cat]) => cat),
    mostWatched: [...topWatch.values()].sort((a, b) => b.playCount - a.playCount || b.totalWatchMs - a.totalWatchMs).slice(0, 3),
  };

  return { items: top, reasons, summary };
};

// ─── Cache por usuário ───────────────────────────────────────

const cache = new Map(); // userId -> { expiresAt, data }
const CACHE_TTL_MS = config.cache.ttlRecommendations * 1000;

const cacheGet = (userId) => {
  const entry = cache.get(userId);
  if (!entry) return undefined;
  if (Date.now() >= entry.expiresAt) {
    cache.delete(userId);
    return undefined;
  }
  return entry.data;
};

const cacheSet = (userId, data) => {
  if (cache.size > 5000) cache.clear(); // preserva ordem de grandeza, por lambda
  cache.set(userId, { expiresAt: Date.now() + CACHE_TTL_MS, data });
};

/**
 * Obtém recomendações para o usuário (com cache per-user).
 * @param {string} userId
 * @param {object} ctx { m3uService, healthStatuses, limit }
 * @returns {Promise<{ items: object[], reasons: object, summary: object|null, fromCache: boolean }>}
 */
const getRecommendations = async (userId, ctx = {}) => {
  const startedAt = Date.now();
  const limit = Number(ctx.limit) || config.analytics.recommendationsLimit;

  const cached = cacheGet(userId);
  if (cached) {
    inc('recommendationHits');
    recordRecommendationLatency(Date.now() - startedAt);
    return { ...cached, fromCache: true };
  }
  inc('recommendationMisses');

  try {
    // Dependências injetadas (ver controle na camada HTTP).
    const history = await (ctx.historyProvider || defaultHistoryProvider)(userId);
    const allChannels = (ctx.getAllChannels || defaultChannelsProvider)();
    const statusOk = (ctx.getStatusMap || defaultStatusProvider)();

    const result = scoreRecommendations(history, allChannels, statusOk, limit);
    const payload = { items: result.items.map(itemToPublic), reasons: result.reasons, summary: result.summary, fromCache: false };
    cacheSet(userId, payload);
    return payload;
  } catch (error) {
    throw error;
  } finally {
    recordRecommendationLatency(Date.now() - startedAt);
  }
};

// Providers default (injetados por quem usa o serviço na prática).
const { getRecentHistory } = require('./playbackService');
const M3UService = require('./m3uService');
const { toPublicChannel } = require('../utils/publicChannel');

const defaultHistoryProvider = (userId) => getRecentHistory(userId, 100);

const defaultChannelsProvider = () => M3UService.getShared().getAllChannels();

// Sem dados de health por padrão (criar um ChannelHealthService aqui
// dispararia N checagens de rede a cada cold start do lambda de usuário).
// Se o chamador tiver statuses disponíveis, passa via ctx.getStatusMap.
const defaultStatusProvider = () => new Map();

const itemToPublic = (item) => rolePublicChannel(item.channel);

// idempotente: garante shape público mesmo para canais já sanitizados
const rolePublicChannel = (ch) => toPublicChannel(ch);

/**
 * Invalida o cache de um usuário (ex.: após evento de histórico).
 * Hoje o TTL resolve; método exposto para uso futuro/consistência.
 */
const invalidateUser = (userId) => {
  cache.delete(userId);
};

module.exports = {
  getRecommendations,
  invalidateUser,
  scoreRecommendations,
  buildAffinity,
};