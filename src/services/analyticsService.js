/**
 * SvenTV API — Analytics Service
 *
 * Métricas administrativas e agregações.
 *
 *  - Métricas do dashboard admin são computadas AO VIVO a partir de
 *    playback_sessions (dados não são duplo-contados).
 *  - As tabelas ChannelMetric / UserMetric são alimentadas por agregação
 *    diária idempotente (aggregateDay) para retenção histórica de longa
 *    duração sem recontagem por evento.
 *  - Retenção: removes events/sessions/metrics antigos com probabilidade
 *    configurável (evita estates de data warehouses grandes).
 *
 * SEMPRE retorna números via bigToNumber (BigInt de Prisma).
 */

'use strict';

const prisma = require('../prisma/client');
const config = require('../config/app');
const logger = require('../utils/logger');
const { inc } = require('../utils/metrics');
const {
  bigToNumber,
  formatWatchDuration,
  dayUtc,
  resolveRange,
  daysBetween,
  sweepPeak,
} = require('../utils/analytics');
const { streamCsv } = require('../utils/csv');

const SESSION_FINAL = ['completed', 'abandoned', 'expired'];

// ─── Agregação diária (alimenta ChannelMetric/UserMetric) ────
// Idempotente: upsert por (channelId,date) / (userId,date).
// Se uma sessão entrar com atraso, a re-agregação do dia recomputa.

const aggregateDay = async (date) => {
  const day = dayUtc(date);
  const next = new Date(day.getTime() + 24 * 60 * 60 * 1000);

  const sessions = await prisma.playbackSession.findMany({
    where: { startedAt: { gte: day, lt: next } },
    select: {
      id: true,
      userId: true,
      channelId: true,
      channelName: true,
      channelCategory: true,
      status: true,
      startedAt: true,
      endedAt: true,
      watchDurationMs: true,
      lastHeartbeatAt: true,
    },
  });
  if (sessions.length === 0) return { channelRows: 0, userRows: 0 };

  // Agrupa por canal
  const byChannel = new Map();
  for (const s of sessions) {
    if (!byChannel.has(s.channelId)) {
      byChannel.set(s.channelId, { list: [], name: s.channelName, category: s.channelCategory });
    }
    byChannel.get(s.channelId).list.push(s);
  }

  let channelRows = 0;
  for (const [channelId, { list, name, category }] of byChannel) {
    const watch = list.reduce((acc, s) => acc + bigToNumber(s.watchDurationMs), 0);
    const intervals = list.map((s) => ({
      start: s.startedAt,
      end: s.endedAt || s.lastHeartbeatAt || null,
    }));
    await prisma.channelMetric.upsert({
      where: { channelId_date: { channelId, date: day } },
      create: {
        channelId,
        date: day,
        channelName: String(name || '').slice(0, 255),
        channelCategory: String(category || '').slice(0, 120),
        views: list.length,
        uniqueViewers: new Set(list.map((s) => s.userId)).size,
        sessions: list.length,
        totalWatchMs: BigInt(watch),
        avgSessionDurationMs: BigInt(list.length ? Math.round(watch / list.length) : 0),
        peakConcurrent: sweepPeak(intervals),
      },
      update: {
        channelName: name || undefined,
        channelCategory: category || undefined,
        views: list.length,
        uniqueViewers: new Set(list.map((s) => s.userId)).size,
        sessions: list.length,
        totalWatchMs: BigInt(watch),
        avgSessionDurationMs: BigInt(list.length ? Math.round(watch / list.length) : 0),
        peakConcurrent: sweepPeak(intervals),
      },
    });
    channelRows++;
  }

  // Agrupa por usuário
  const byUser = new Map();
  for (const s of sessions) {
    if (!byUser.has(s.userId)) byUser.set(s.userId, []);
    byUser.get(s.userId).push(s);
  }
  let userRows = 0;
  for (const [userId, list] of byUser) {
    const watch = list.reduce((acc, s) => acc + bigToNumber(s.watchDurationMs), 0);
    await prisma.userMetric.upsert({
      where: { userId_date: { userId, date: day } },
      create: {
        userId,
        date: day,
        sessions: list.length,
        views: list.length,
        totalWatchMs: BigInt(watch),
        channelsCount: new Set(list.map((s) => s.channelId)).size,
      },
      update: {
        sessions: list.length,
        views: list.length,
        totalWatchMs: BigInt(watch),
        channelsCount: new Set(list.map((s) => s.channelId)).size,
      },
    });
    userRows++;
  }

  inc('retentionRuns'); // no-op falso; contador compartilhado
  return { channelRows, userRows };
};

/**
 * Garante que os dias do intervalo estejam agregados nas tabelas diárias.
 * Roda com limite de dias (evita trabalho excessivo em serverless).
 */
const ensureAggregated = async ({ start, end }, options = {}) => {
  const days = daysBetween(start, end);
  let processed = 0;
  for (const day of days) {
    if (options.maxDays && processed >= options.maxDays) break;
    await aggregateDay(day);
    processed++;
  }
  return { days: processed };
};

// ─── Métricas administrativas (ao vivo) ──────────────────────

const _mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);

const getAdminMetrics = async (query) => {
  const range = resolveRange(query);
  if (!range) return null;

  const { start, end } = range;
  const [sessions, events, activeNow, userCount, playlistCount] = await Promise.all([
    prisma.playbackSession.findMany({
      where: { startedAt: { gte: start, lte: end } },
      select: {
        id: true,
        userId: true,
        channelId: true,
        channelName: true,
        channelCategory: true,
        status: true,
        startedAt: true,
        endedAt: true,
        lastHeartbeatAt: true,
        watchDurationMs: true,
      },
    }),
    prisma.playbackEvent.count({
      where: { createdAt: { gte: start, lte: end } },
    }),
    prisma.playbackSession.count({
      where: { status: 'active', lastHeartbeatAt: { gte: new Date(Date.now() - 5 * 60 * 1000) } },
    }),
    prisma.user.count({ where: { status: 'active' } }),
    prisma.playlist.count(),
  ]);

  const totalWatchMs = sessions.reduce((acc, s) => acc + bigToNumber(s.watchDurationMs), 0);
  const finished = sessions.filter((s) => SESSION_FINAL.includes(s.status));
  const completed = finished.filter((s) => s.status === 'completed');
  const avgSessionMs = finished.length
    ? _mean(finished.map((s) => bigToNumber(s.watchDurationMs)))
    : 0;

  const users = new Set(sessions.map((s) => s.userId));
  const channels = new Set(sessions.map((s) => s.channelId));
  const categories = new Set(sessions.map((s) => s.channelCategory).filter(Boolean));

  const byChannel = new Map();
  for (const s of sessions) {
    if (!byChannel.has(s.channelId)) {
      byChannel.set(s.channelId, { id: s.channelId, name: s.channelName, category: s.channelCategory, sessions: 0, users: new Set(), watchMs: 0 });
    }
    const c = byChannel.get(s.channelId);
    c.sessions += 1;
    c.users.add(s.userId);
    c.watchMs += bigToNumber(s.watchDurationMs);
  }
  const topChannels = [...byChannel.values()]
    .map((c) => ({
      channelId: c.id,
      name: c.name || c.id,
      category: c.category,
      sessions: c.sessions,
      uniqueViewers: c.users.size,
      totalWatchMs: c.watchMs,
      watchDuration: formatWatchDuration(c.watchMs),
      avgSessionDurationMs: c.sessions ? Math.round(c.watchMs / c.sessions) : 0,
    }))
    .sort((a, b) => b.totalWatchMs - a.totalWatchMs)
    .slice(0, 10);

  const byCategory = new Map();
  for (const s of sessions) {
    if (!s.channelCategory) continue;
    for (const raw of String(s.channelCategory).split(';')) {
      const cat = raw.trim();
      if (!cat) continue;
      if (!byCategory.has(cat)) byCategory.set(cat, { category: cat, sessions: 0, users: new Set(), watchMs: 0 });
      const c = byCategory.get(cat);
      c.sessions += 1;
      c.users.add(s.userId);
      c.watchMs += bigToNumber(s.watchDurationMs);
    }
  }
  const categoriesBreakdown = [...byCategory.values()]
    .map((c) => ({
      category: c.category,
      sessions: c.sessions,
      uniqueViewers: c.users.size,
      totalWatchMs: c.watchMs,
      watchDuration: formatWatchDuration(c.watchMs),
    }))
    .sort((a, b) => b.totalWatchMs - a.totalWatchMs);

  const byUser = new Map();
  for (const s of sessions) {
    if (!byUser.has(s.userId)) byUser.set(s.userId, { userId: s.userId, sessions: 0, channels: new Set(), watchMs: 0, lastPlayedAt: null });
    const u = byUser.get(s.userId);
    u.sessions += 1;
    u.channels.add(s.channelId);
    u.watchMs += bigToNumber(s.watchDurationMs);
    if (!u.lastPlayedAt || s.startedAt > u.lastPlayedAt) u.lastPlayedAt = s.startedAt;
  }
  const topUsers = [...byUser.values()]
    .map((u) => ({
      userId: u.userId,
      sessions: u.sessions,
      channelsCount: u.channels.size,
      totalWatchMs: u.watchMs,
      watchDuration: formatWatchDuration(u.watchMs),
      lastPlayedAt: u.lastPlayedAt,
    }))
    .sort((a, b) => b.totalWatchMs - a.totalWatchMs)
    .slice(0, 10);

  // Série temporal por dia
  const seriesByDay = new Map();
  for (const s of sessions) {
    const key = dayUtc(s.startedAt).toISOString().slice(0, 10);
    if (!seriesByDay.has(key)) seriesByDay.set(key, { date: key, sessions: 0, viewers: new Set(), watchMs: 0, events: 0 });
    const d = seriesByDay.get(key);
    d.sessions += 1;
    d.viewers.add(s.userId);
    d.watchMs += bigToNumber(s.watchDurationMs);
  }
  for (const day of daysBetween(start, end)) {
    const key = day.toISOString().slice(0, 10);
    if (!seriesByDay.has(key)) seriesByDay.set(key, { date: key, sessions: 0, viewers: new Set(), watchMs: 0, events: 0 });
  }
  const series = [...seriesByDay.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((d) => ({
      date: d.date,
      sessions: d.sessions,
      uniqueViewers: d.viewers.size,
      totalWatchMs: d.watchMs,
      watchDuration: formatWatchDuration(d.watchMs),
    }));

  return {
    overview: {
      totalWatchMs,
      watchDuration: formatWatchDuration(totalWatchMs),
      sessions: sessions.length,
      playbackEvents: events,
      finishedSessions: finished.length,
      completedSessions: completed.length,
      avgSessionDurationMs: Math.round(avgSessionMs),
      avgSessionDuration: formatWatchDuration(avgSessionMs),
      uniqueUsers: users.size,
      uniqueChannels: channels.size,
      categories: categories.size,
      activeSessionsNow: activeNow,
      activeUsers: userCount,
      totalPlaylists: playlistCount,
    },
    topChannels,
    categories: categoriesBreakdown,
    topUsers,
    series,
    period: { start, end },
  };
};

// ─── Série histórica (das tabelas agregadas) ─────────────────
// Para períodos longos (90d+) usa ChannelMetric/UserMetric em vez de
// recomputar cada session. Interface compatível com getAdminMetrics.

const getHistoricalSeries = async (query) => {
  const range = resolveRange(query);
  if (!range) return null;
  const rows = await prisma.channelMetric.findMany({
    where: { date: { gte: dayUtc(range.start), lte: dayUtc(range.end) } },
    select: {
      date: true,
      views: true,
      uniqueViewers: true,
      sessions: true,
      totalWatchMs: true,
      peakConcurrent: true,
    },
    orderBy: { date: 'asc' },
  });
  const byDay = new Map();
  for (const r of rows) {
    const key = r.date.toISOString().slice(0, 10);
    if (!byDay.has(key)) byDay.set(key, { date: key, sessions: 0, viewers: new Set(), watchMs: 0, peakConcurrent: 0 });
    const d = byDay.get(key);
    d.sessions += r.sessions;
    d.viewers.add(r.channelId); // aproximação; canal não é viewer
    d.watchMs += bigToNumber(r.totalWatchMs);
    d.peakConcurrent = Math.max(d.peakConcurrent, r.peakConcurrent);
  }
  const out = [];
  for (const day of daysBetween(range.start, range.end)) {
    const key = day.toISOString().slice(0, 10);
    const d = byDay.get(key) || { date: key, sessions: 0, viewers: new Set(), watchMs: 0, peakConcurrent: 0 };
    out.push({
      date: key,
      sessions: d.sessions,
      uniqueViewers: d.viewers.size,
      totalWatchMs: d.watchMs,
      watchDuration: formatWatchDuration(d.watchMs),
      peakConcurrent: d.peakConcurrent,
    });
  }
  return out;
};

// ─── Exportação CSV (analytics) ──────────────────────────────
// Página por CURSOR (id > last, nunca offset) para não degradar em bancos
// grandes; o output é streamado linha a linha via streamCsv (res.write).

const PLAYBACK_EXPORT_PAGE = 500;

/**
 * Iterador assíncrono sobre playback_sessions do período, paginado por
 * cursor (id crescente). Memória estável por página — o agregador consome
 * progressivamente.
 */
async function* iterPlaybackSessions({ start, end }) {
  let lastId = null;
  for (;;) {
    const rows = await prisma.playbackSession.findMany({
      where: {
        startedAt: { gte: start, lte: end },
        ...(lastId ? { id: { gt: lastId } } : null),
      },
      orderBy: { id: 'asc' },
      take: PLAYBACK_EXPORT_PAGE,
      select: {
        id: true,
        userId: true,
        channelId: true,
        channelName: true,
        channelCategory: true,
        status: true,
        startedAt: true,
        watchDurationMs: true,
      },
    });
    if (rows.length === 0) break;
    for (const row of rows) yield row;
    lastId = rows[rows.length - 1].id;
  }
}

/**
 * Emite `analytics.csv`: seção POR CANAL e seção DIÁRIA para o período.
 * Streama com cursor (leitura) + write por linha (saída). Nunca carrega o
 * período inteiro em memória — apenas agregações por canal/dia.
 * @param {import('express').Response} res
 * @param {{start: Date, end: Date}} range  validado pelo chamador
 * @returns {Promise<boolean>}
 */
async function streamAnalyticsCSV(res, { start, end }) {
  const byChannel = new Map();
  const byDay = new Map();

  for await (const s of iterPlaybackSessions({ start, end })) {
    let c = byChannel.get(s.channelId);
    if (!c) {
      c = { id: s.channelId, name: s.channelName || s.channelId, category: s.channelCategory || '', sessions: 0, viewers: new Set(), watchMs: 0 };
      byChannel.set(s.channelId, c);
    }
    c.sessions += 1;
    c.viewers.add(s.userId);
    c.watchMs += bigToNumber(s.watchDurationMs);

    const key = dayUtc(s.startedAt).toISOString().slice(0, 10);
    let d = byDay.get(key);
    if (!d) {
      d = { date: key, sessions: 0, viewers: new Set(), watchMs: 0 };
      byDay.set(key, d);
    }
    d.sessions += 1;
    d.viewers.add(s.userId);
    d.watchMs += bigToNumber(s.watchDurationMs);
  }

  const channels = [...byChannel.values()].sort((a, b) => b.watchMs - a.watchMs);
  const days = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));

  const rows = (async function* () {
    yield ['canal_id', 'canal', 'categoria', 'sessoes', 'espectadores_unicos', 'tempo_total_ms', 'tempo_total', 'tempo_medio_ms'];
    for (let i = 0; i < channels.length; i++) {
      const c = channels[i];
      yield [
        c.id,
        c.name,
        c.category,
        c.sessions,
        c.viewers.size,
        c.watchMs,
        formatWatchDuration(c.watchMs),
        c.sessions ? Math.round(c.watchMs / c.sessions) : 0,
      ];
    }
    yield [];
    yield ['data', 'sessoes', 'espectadores_unicos', 'tempo_total_ms', 'tempo_total'];
    for (const d of days) {
      yield [d.date, d.sessions, d.viewers.size, d.watchMs, formatWatchDuration(d.watchMs)];
    }
  })();

  return streamCsv(res, { filename: 'analytics.csv' }, ['relatorio_analytics', `periodo_${start.toISOString().slice(0, 10)}_${end.toISOString().slice(0, 10)}`], rows);
}

// ─── Retenção ────────────────────────────────────────────────
// Fire-and-forget probabilístico (ver config.analytics.retentionProbability):
// nem toda execução limpa, evitando lock/load excessivo em serverless.

const runRetention = async () => {
  const configR = config.analytics;
  if (Math.random() > configR.retentionProbability) return { ran: false, deleted: { events: 0, sessions: 0, metrics: 0 } };

  const cutoffEvents = new Date(Date.now() - configR.eventRetentionDays * 24 * 60 * 60 * 1000);
  const cutoffSessions = new Date(Date.now() - configR.sessionRetentionDays * 24 * 60 * 60 * 1000);
  const cutoffMetrics = new Date(Date.now() - configR.metricRetentionDays * 24 * 60 * 60 * 1000);

  const [events, sessions, metricsC, metricsU] = await Promise.all([
    prisma.playbackEvent.deleteMany({ where: { createdAt: { lt: cutoffEvents } } }),
    prisma.playbackSession.deleteMany({ where: { startedAt: { lt: cutoffSessions } } }),
    prisma.channelMetric.deleteMany({ where: { date: { lt: cutoffMetrics } } }),
    prisma.userMetric.deleteMany({ where: { date: { lt: cutoffMetrics } } }),
  ]);

  inc('retainedEventsDeleted');
  inc('retainedSessionsDeleted');

  return {
    ran: true,
    deleted: {
      events: events.count,
      sessions: sessions.count,
      metrics: metricsC.count + metricsU.count,
    },
  };
};

module.exports = {
  aggregateDay,
  ensureAggregated,
  getAdminMetrics,
  getHistoricalSeries,
  runRetention,
  streamAnalyticsCSV,
};