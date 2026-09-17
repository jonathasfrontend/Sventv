'use strict';

/**
 * Controle de streams simultâneos por usuário.
 *
 * Limita quantos streams HLS ativos um mesmo usuário/token pode manter
 * abertos via proxy. Com Upstash Redis (REST) o limite vale entre
 * instâncias/lambdas (global); se o Redis ficar indisponível, o fallback
 * em memória mantém a proteção por instância com métrica de fallback.
 * Usado apenas na fase de player (não bloqueia os segmentos REST
 * individuais, que já têm rate limiter).
 */

const config = require('../config/app');
const logger = require('../utils/logger');
const redisStore = require('../services/redisStore');
const { inc } = require('../utils/metrics');

const ACTIVE_DEFAULT = Number(process.env.STREAM_MAX_ACTIVE) || 1;
const TTL_MS = Number(process.env.STREAM_SLOT_TTL_MS) || 5 * 60 * 1000;

const active = new Map(); // key -> { count, lastUsed }

function keyFor(req) {
  const uid = req.user?.id || req.authUser?.id;
  if (uid) return `u:${uid}`;
  return `ip:${req.ip || 'unknown'}`;
}

function redisKeyFor(key) {
  return redisStore.makeKey('stream', 'active', key);
}

function memAcquireSlot(key) {
  const now = Date.now();

  const entry = active.get(key);
  if (entry && now - entry.lastUsed > TTL_MS) {
    // Expirou: zera (janela deslizante simples por TTL)
    active.delete(key);
  }

  const current = active.get(key) || { count: 0, lastUsed: now };
  if (current.count >= ACTIVE_DEFAULT) {
    active.set(key, current);
    return false;
  }

  current.count += 1;
  current.lastUsed = now;
  active.set(key, current);
  return true;
}

function memReleaseSlot(key) {
  const entry = active.get(key);
  if (!entry) return;
  entry.count = Math.max(0, entry.count - 1);
  entry.lastUsed = Date.now();
  if (entry.count === 0) {
    active.delete(key);
  }
}

/**
 * Tenta adquirir uma vaga de stream para o usuário da requisição.
 * @returns {Promise<boolean>} true se adquiriu, false se excedeu o limite.
 */
async function acquireSlot(req) {
  const key = keyFor(req);

  if (await redisStore.isRedisAvailable()) {
    const rkey = redisKeyFor(key);
    try {
      // TTL no Redis age como fallback contra lambda morta: uma instância
      // que nunca libera a vaga perde-a após STREAM_SLOT_TTL_MS.
      const count = await redisStore.incrWithTTL(rkey, config.redis.slotTtlMs);
      if (count > ACTIVE_DEFAULT) {
        await redisStore.decr(rkey);
        return false;
      }
      return true;
    } catch (err) {
      inc('redisErrors');
      inc('streamLimiterFallbacks');
      logger.warn(`Stream limiter Redis fallback: ${err && err.message}`);
    }
  }

  return memAcquireSlot(key);
}

/**
 * Libera uma vaga de stream previamente adquirida (idempotente).
 * NUNCA lança — executa no handler 'close' da resposta.
 */
async function releaseSlot(req) {
  try {
    const key = keyFor(req);

    if (await redisStore.isRedisAvailable()) {
      const rkey = redisKeyFor(key);
      await redisStore.decr(rkey);
      return;
    }

    memReleaseSlot(key);
  } catch (err) {
    inc('redisErrors');
    inc('streamLimiterFallbacks');
    logger.warn(`Stream limiter Redis fallback (release): ${err && err.message}`);
  }
}

module.exports = {
  acquireSlot,
  releaseSlot,
  keyFor,
  ACTIVE_DEFAULT,
};