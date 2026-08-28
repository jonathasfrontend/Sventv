'use strict';

/**
 * Controle de streams simultâneos por usuário (em memória).
 *
 * Limita quantos streams HLS ativos um mesmo usuário/token pode manter
 * abertos via proxy. No serverless o limite vale por instância/lambda —
 * mitigação parcial, documentada. Usado apenas na fase de player (não
 * bloqueia os segmentos REST individuais, que já têm rate limiter).
 */

const ACTIVE_DEFAULT = Number(process.env.STREAM_MAX_ACTIVE) || 1;
const TTL_MS = Number(process.env.STREAM_SLOT_TTL_MS) || 5 * 60 * 1000;

const active = new Map(); // key -> { count, lastUsed }

function keyFor(req) {
  const uid = req.user?.id || req.authUser?.id;
  if (uid) return `u:${uid}`;
  return `ip:${req.ip || 'unknown'}`;
}

/**
 * Tenta adquirir uma vaga de stream para o usuário da requisição.
 * @returns {Promise<boolean>} true se adquiriu, false se excedeu o limite.
 */
async function acquireSlot(req) {
  const key = keyFor(req);
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

/**
 * Libera uma vaga de stream previamente adquirida.
 */
function releaseSlot(req) {
  const key = keyFor(req);
  const entry = active.get(key);
  if (!entry) return;
  entry.count = Math.max(0, entry.count - 1);
  entry.lastUsed = Date.now();
  if (entry.count === 0) {
    active.delete(key);
  }
}

module.exports = {
  acquireSlot,
  releaseSlot,
  keyFor,
  ACTIVE_DEFAULT,
};
