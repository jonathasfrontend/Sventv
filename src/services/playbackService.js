/**
 * SvenTV API — Playback Service
 *
 * Responsável por:
 *  - Ingestão de eventos discretos de reprodução (play, pause, resume,
 *    stop, ended) em playback_events.
 *  - Manutenção das sessões de reprodução (playback_sessions): heartbeat
 *    atualiza APENAS a sessão (sem linha de evento), transições discretas
 *    gravam a linha de evento.
 *  - Estimativa de watch time (acumula watchDurationMs monotônico).
 *  - Expiração (finalização) de sessões abandonadas por timeout quando o
 *    usuário fecha o navegador sem enviar stop.
 *  - Consolidação do histórico (watch_history) — 1 linha por (user, canal).
 *
 * Regras de design:
 *  - BigInt do Prisma é convertido via bigToNumber antes de serializar.
 *  - Finalização é idempotente (updateMany com guarda de status): chamadas
 *    simultâneas de stop/ended/expiração não duplicam contagem.
 *  - Ownership é sempre validado (sessionId pertence ao userId autenticado).
 */

'use strict';

const prisma = require('../prisma/client');
const config = require('../config/app');
const logger = require('../utils/logger');
const { inc, recordEventIngestLatency } = require('../utils/metrics');
const { bigToNumber } = require('../utils/analytics');

const EVENTS = new Set(['play', 'pause', 'resume', 'stop', 'ended']);
const FINAL_STATUSES = ['completed', 'abandoned', 'expired'];

const InputError = (message, statusCode = 422) => {
  const e = new Error(message);
  e.statusCode = statusCode;
  return e;
};

/**
 * Snapshot de exibição do canal (público, sem URL upstream).
 * Se o canal sumir do M3U após o registro, os metadados persistidos
 * continuam exibíveis.
 */
const channelSnapshot = (channel) => {
  if (!channel) return { name: null, logo: null, category: null };
  return {
    name: channel.name ? String(channel.name).slice(0, 255) : null,
    logo: channel.logo ? String(channel.logo).slice(0, 512) : null,
    category: channel.category ? String(channel.category).slice(0, 120) : null,
  };
};

/**
 * Finaliza TODAS as sessões ativas do usuário cujo último heartbeat é
 * mais antigo que a janela de expiração (timeout de navegador fechado).
 * Disparado oportunamente a cada ingestão (índice user+lastHeartbeatAt).
 */
const finalizeExpiredForUser = async (userId) => {
  const cutoff = new Date(Date.now() - config.analytics.sessionExpiryMs);
  const expired = await prisma.playbackSession.findMany({
    where: { userId, status: 'active', lastHeartbeatAt: { lt: cutoff } },
    select: { id: true },
    take: 50,
  });
  let closed = 0;
  for (const { id } of expired) {
    if (await finalizeSession(id, 'abandoned', 0)) closed++;
  }
  return closed;
};

/**
 * Finaliza sessões ativas STALE de TODOS os usuários (job de agregação e
 * retenção). Batch limitado para não segurar a transação.
 */
const finalizeExpiredGlobally = async (batch = 200) => {
  const cutoff = new Date(Date.now() - config.analytics.sessionExpiryMs);
  const expired = await prisma.playbackSession.findMany({
    where: { status: 'active', lastHeartbeatAt: { lt: cutoff } },
    select: { id: true },
    take: batch,
  });
  let closed = 0;
  for (const { id } of expired) {
    if (await finalizeSession(id, 'abandoned', 0)) closed++;
  }
  return closed;
};

/**
 * Finaliza uma sessão (stop/ended manual OU abandono por timeout).
 *
 * Idempotente: updateMany restringe a statuses não-final; se outra
 * requisição já finalizou, count === 0 e nenhum incremento acontece.
 */
const finalizeSession = async (sessionPk, status, finalMs, { event, at } = {}) => {
  const t = at || new Date();
  const cur = await prisma.playbackSession.findUnique({
    where: { id: sessionPk },
  });
  if (!cur) return false;

  const prevMs = bigToNumber(cur.watchDurationMs);
  const targetMs = Math.max(prevMs, Math.max(0, Math.floor(Number(finalMs) || 0)));
  const delta = targetMs - prevMs;

  const locked = await prisma.playbackSession.updateMany({
    where: { id: sessionPk, status: { notIn: FINAL_STATUSES } },
    data: {
      status,
      endedAt: t,
      lastHeartbeatAt: cur.lastHeartbeatAt || t,
      watchDurationMs: BigInt(targetMs),
    },
  });
  if (locked.count === 0) return false;

  const meta = {
    channelName: cur.channelName,
    channelLogo: cur.channelLogo,
    channelCategory: cur.channelCategory,
  };

  // Consolida o watch time na linha de histórico do usuário.
  await prisma.watchHistory.upsert({
    where: { userId_channelId: { userId: cur.userId, channelId: cur.channelId } },
    create: {
      userId: cur.userId,
      channelId: cur.channelId,
      channelName: meta.channelName,
      channelLogo: meta.channelLogo,
      channelCategory: meta.channelCategory,
      totalWatchMs: BigInt(delta),
      sessionsCount: 1,
      playCount: 1,
      lastPlayedAt: cur.startedAt,
    },
    update: {
      totalWatchMs: { increment: BigInt(delta) },
      sessionsCount: { increment: 1 },
      channelName: meta.channelName || undefined,
      channelLogo: meta.channelLogo || undefined,
      channelCategory: meta.channelCategory || undefined,
    },
  });

  if (event) {
    await prisma.playbackEvent.create({
      data: {
        sessionId: cur.sessionId,
        userId: cur.userId,
        channelId: cur.channelId,
        event,
        watchDurationMs: BigInt(targetMs),
      },
    });
    inc('eventsIngested');
  }
  inc('sessionsFinalized');
  return true;
};

/**
 * Ingestão de evento discreto de reprodução.
 * @returns {Promise<{ok: boolean, code?: string, message?: string}>}
 */
const ingestEvent = async ({ userId, channelId, sessionId, event, watchDurationMs, channelMeta }) => {
  const startedAt = Date.now();
  try {
    if (!userId) throw InputError('Usuário não identificado.', 401);
    if (!sessionId || typeof sessionId !== 'string' || sessionId.length > 80) {
      throw InputError('sessionId inválido.');
    }
    if (!EVENTS.has(event)) throw InputError(`Evento inválido: "${event}".`);
    if (!channelId || typeof channelId !== 'string' || channelId.length > 255) {
      throw InputError('channelId inválido.');
    }

    const meta = channelSnapshot(channelMeta);
    const ms = Math.max(0, Math.floor(Number(watchDurationMs) || 0));
    const t = new Date();

    // Expira sessões abandonadas deste usuário (barato, oportunista).
    await finalizeExpiredForUser(userId);

    if (event === 'play') {
      const existing = await prisma.playbackSession.findUnique({ where: { sessionId } });

      if (existing && existing.userId !== userId) {
        // Colisão de id entre usuários (praticamente impossível com UUID):
        // rejeita em vez de contaminar a sessão de outro usuário.
        return { ok: false, code: 'SESSION_OWNERSHIP' };
      }

      let session;
      if (existing) {
        session = await prisma.playbackSession.update({
          where: { id: existing.id },
          data: {
            status: 'active',
            lastHeartbeatAt: t,
            endedAt: null,
            pausedAt: null,
            watchDurationMs: BigInt(ms),
            channelId,
            channelName: meta.name || existing.channelName || null,
            channelLogo: meta.logo || existing.channelLogo || null,
            channelCategory: meta.category || existing.channelCategory || null,
          },
        });
      } else {
        session = await prisma.playbackSession.create({
          data: {
            sessionId,
            userId,
            channelId,
            status: 'active',
            startedAt: t,
            lastHeartbeatAt: t,
            watchDurationMs: BigInt(ms),
            channelName: meta.name,
            channelLogo: meta.logo,
            channelCategory: meta.category,
          },
        });
        inc('sessionsStarted');
      }

      // Linha de evento discreto (play).
      await prisma.playbackEvent.create({
        data: { sessionId, userId, channelId, event: 'play', watchDurationMs: BigInt(ms) },
      });

      // Histórico: garante linha existente e marca fresh.
      await prisma.watchHistory.upsert({
        where: { userId_channelId: { userId, channelId } },
        create: {
          userId,
          channelId,
          playCount: 1,
          lastPlayedAt: t,
          totalWatchMs: BigInt(0),
          sessionsCount: 0,
          channelName: meta.name || null,
          channelLogo: meta.logo || null,
          channelCategory: meta.category || null,
        },
        update: {
          playCount: { increment: 1 },
          lastPlayedAt: t,
          channelName: meta.name || undefined,
          channelLogo: meta.logo || undefined,
          channelCategory: meta.category || undefined,
        },
      });

      inc('eventsIngested');
      return { ok: true, sessionId };
    }

    if (event === 'pause' || event === 'resume') {
      const session = await prisma.playbackSession.findUnique({ where: { sessionId } });
      if (!session || session.userId !== userId) {
        return { ok: false, code: 'NO_SESSION', message: 'Sessão de reprodução não encontrada.' };
      }

      await prisma.playbackSession.update({
        where: { id: session.id },
        data: {
          status: event === 'pause' ? 'paused' : 'active',
          pausedAt: event === 'pause' ? t : null,
          lastHeartbeatAt: t,
          watchDurationMs: BigInt(Math.max(bigToNumber(session.watchDurationMs), ms)),
        },
      });

      await prisma.playbackEvent.create({
        data: { sessionId, userId, channelId, event, watchDurationMs: BigInt(ms) },
      });
      inc('eventsIngested');
      return { ok: true };
    }

    if (event === 'stop' || event === 'ended') {
      const session = await prisma.playbackSession.findUnique({ where: { sessionId } });
      if (!session || session.userId !== userId) {
        return { ok: false, code: 'NO_SESSION', message: 'Sessão de reprodução não encontrada.' };
      }

      const finalized = await finalizeSession(session.id, 'completed', ms, { event, at: t });
      if (!finalized) {
        return { ok: true, code: 'ALREADY_FINALIZED' };
      }
      return { ok: true };
    }
    return { ok: false, code: 'UNHANDLED_EVENT' };
  } finally {
    recordEventIngestLatency(Date.now() - startedAt);
  }
};

/**
 * Heartbeat — atualiza APENAS a sessão (sem linha de evento), mantendo o
 * watch time cumulativo monotônico. Não grava evento para não inflar
 * playback_events.
 */
const heartbeat = async ({ userId, sessionId, watchDurationMs }) => {
  if (!userId) throw InputError('Usuário não identificado.', 401);
  if (!sessionId || typeof sessionId !== 'string' || sessionId.length > 80) {
    throw InputError('sessionId inválido.');
  }

  const ms = Math.max(0, Math.floor(Number(watchDurationMs) || 0));
  const result = await prisma.playbackSession.updateMany({
    where: { sessionId, userId, status: 'active' },
    data: { lastHeartbeatAt: new Date(), watchDurationMs: BigInt(ms) },
  });
  inc('heartbeatsIngested');

  if (result.count === 0) {
    const exists = await prisma.playbackSession.findUnique({
      where: { sessionId },
      select: { userId: true, status: true },
    });
    if (!exists || exists.userId !== userId) {
      return { ok: false, code: 'NO_SESSION' };
    }
    // Sessão inativa (pausada/finalizada) ou expirada sem play novo:
    // o player deve reenviar um "play" para recriar.
    return { ok: false, code: 'INACTIVE', status: exists.status };
  }

  return { ok: true };
};

// ─────────────────────────────────────────────────────────────
// Histórico (leitura)
// ─────────────────────────────────────────────────────────────

const serializeHistory = (row) => ({
  id: row.id,
  channelId: row.channelId,
  channelName: row.channelName,
  channelLogo: row.channelLogo,
  channelCategory: row.channelCategory,
  playCount: row.playCount,
  sessionsCount: row.sessionsCount,
  totalWatchMs: bigToNumber(row.totalWatchMs),
  lastPlayedAt: row.lastPlayedAt,
  createdAt: row.createdAt,
});

/**
 * Histórico consolidado com paginação cursor-based.
 * @returns {Promise<{items: object[], nextCursor: string|null, hasMore: boolean}>}
 */
const getHistory = async (userId, { limit = 20, cursor } = {}) => {
  const take = Math.min(Math.max(Number(limit) || 20, 1), 50);
  const where = { userId };
  const realTake = take + 1;

  const items = await prisma.watchHistory.findMany({
    where: cursor ? { ...where, lastPlayedAt: { lt: new Date(cursor) } } : where,
    orderBy: { lastPlayedAt: 'desc' },
    take: realTake,
  });

  const hasMore = items.length > realTake - 1;
  const rows = hasMore ? items.slice(0, take) : items;
  const nextCursor = hasMore ? rows[rows.length - 1].lastPlayedAt.toISOString() : null;

  return {
    items: rows.map(serializeHistory),
    nextCursor,
    hasMore,
  };
};

/**
 * Usado pela dashboard e pelos "Assistidos recentemente".
 * Sem paginação (lista curta e indexada por user+lastPlayedAt).
 */
const getRecentHistory = async (userId, limit = config.analytics.recentHistoryLimit) => {
  const rows = await prisma.watchHistory.findMany({
    where: { userId },
    orderBy: { lastPlayedAt: 'desc' },
    take: Math.min(Math.max(Number(limit) || config.analytics.recentHistoryLimit, 1), 50),
  });
  return rows.map(serializeHistory);
};

// ─────────────────────────────────────────────────────────────
// Live Control (leitura) — espectadores por canal
// ─────────────────────────────────────────────────────────────

/**
 * Espectadores ativos agrupados por canal.
 *
 * Considera "ao vivo agora" a sessão com status='active' e último heartbeat
 * dentro da janela de expiração (default 90s = 3× heartbeat). Não distingue
 * instâncias lambda — é um retrato do banco, portanto global.
 *
 * @param {{limit?: number}} opts
 * @returns {Promise<{total: number, channels: Array<{channelId:string, channelName:string|null, channelCategory:string|null, viewers:number}>}>}
 */
const getActiveViewersByChannel = async ({ limit = 50 } = {}) => {
  const cutoff = new Date(Date.now() - config.analytics.sessionExpiryMs);
  const take = Math.min(Math.max(Number(limit) || 50, 1), 200);

  const groups = await prisma.playbackSession.groupBy({
    by: ['channelId'],
    where: { status: 'active', lastHeartbeatAt: { gt: cutoff } },
    _count: { _all: true },
  });

  const items = groups
    .map((g) => ({ channelId: g.channelId, viewers: g._count._all }))
    .sort((a, b) => b.viewers - a.viewers);

  const total = items.reduce((acc, i) => acc + i.viewers, 0);
  const top = items.slice(0, take);

  if (top.length) {
    const metas = await prisma.playbackSession.findMany({
      where: {
        channelId: { in: top.map((t) => t.channelId) },
        status: 'active',
        lastHeartbeatAt: { gt: cutoff },
      },
      distinct: ['channelId'],
      select: { channelId: true, channelName: true, channelCategory: true },
    });
    const metaMap = new Map(metas.map((m) => [m.channelId, m]));
    top.forEach((t) => {
      const meta = metaMap.get(t.channelId);
      t.channelName = meta ? meta.channelName : null;
      t.channelCategory = meta ? meta.channelCategory : null;
    });
  }

  return { total, channels: top };
};

module.exports = {
  ingestEvent,
  heartbeat,
  finalizeSession,
  finalizeExpiredForUser,
  finalizeExpiredGlobally,
  getHistory,
  getRecentHistory,
  getActiveViewersByChannel,
  channelSnapshot,
};