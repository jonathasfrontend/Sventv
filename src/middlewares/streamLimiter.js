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
 *
 * Contrato de par: `acquireSlot` devolve um "lease" (ou null) e
 * `releaseSlot` recebe ESSE lease. O backend fica gravado no lease de propósito
 * — decidir de novo em `releaseSlot` já causou vazamento: se a disponibilidade
 * do Redis mudasse entre os dois, o acquire incrementava no Redis e o release
 * caía no Map em memória (vazio) e saía sem fazer nada, deixando a vaga presa
 * até o TTL vencer.
 */

const config = require('../config/app');
const logger = require('../utils/logger');
const redisStore = require('../services/redisStore');
const { inc } = require('../utils/metrics');

// 3 (e não 1): o slot é tomado a CADA reload do manifesto ao vivo, e HLS.js
// sobrepõe requisições (reload + retry + troca de nível de ABR). Com 1, o
// próprio usuário se trancava. Ajuste por env conforme a política da conta.
const ACTIVE_DEFAULT = Number(process.env.STREAM_MAX_ACTIVE) || 3;
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
 *
 * @returns {Promise<object|null>} lease sinalizado (liberar com `releaseSlot`),
 *   ou `null` quando o limite foi excedido.
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
        return null;
      }
      // Renova o lease enquanto o stream está de fato ativo: o TTL do
      // `SET NX` só é definido na primeira criação, então sem isto uma sessão
      // longa veria a chave expirar no meio da reprodução. Vaga abandonada não
      // é renovada (a tentativa é recusada antes daqui) e expira sozinha.
      try {
        await redisStore.expire(rkey, config.redis.slotTtlMs);
      } catch (_) { /* renovacao é melhor-esforço; a vaga já foi concedida */ }
      return { backend: 'redis', key, rkey };
    } catch (err) {
      inc('redisErrors');
      inc('streamLimiterFallbacks');
      logger.warn(`Stream limiter Redis fallback: ${err && err.message}`);
    }
  }

  if (!memAcquireSlot(key)) return null;
  return { backend: 'mem', key };
}

/**
 * Libera a vaga SEMPRE no backend que a concedeu (ver contrato de par acima).
 * NUNCA lança — executa no handler 'close' da resposta.
 *
 * @param {object|null} lease valor devolvido por `acquireSlot`
 */
async function releaseSlot(lease) {
  if (!lease) return;
  try {
    if (lease.backend === 'redis') {
      await redisStore.decr(lease.rkey);
      return;
    }
    memReleaseSlot(lease.key);
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