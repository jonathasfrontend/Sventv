/**
 * SvenTV API — redisStore
 *
 * Abstração isolada sobre o Upstash Redis (HTTP/REST — serverless friendly).
 * NUNCA usa cliente TCP; apenas @upstash/redis sobre REST.
 *
 * Responsabilidades:
 *  - getRedisClient()      singleton + lazy init (não conecta sem necessidade)
 *  - isRedisAvailable()    cache curto do estado de disponibilidade (sem
 *                          healthcheck de rede por requisição)
 *  - incrWithTTL(key, ms)  incremento atômico (SET NX + INCR), com TTL
 *  - decr(key)             decremento atômico que nunca fica negativo (eval)
 *  - get(key) / del(key)   auxiliares
 *
 * Kill switch: DISTRIBUTED_STATE_ENABLED=false → isRedisAvailable() retorna
 * false e todos os consumidores caem no fallback em memória (rollback lógico
 * sem novo deploy).
 *
 * NUNCA logar/emitir o token REST ou a URL completa (credenciais pertencem
 * ao ambiente, não a logs/métricas/respostas).
 */

'use strict';

const { Redis } = require('@upstash/redis');
const config = require('../config/app');
const logger = require('../utils/logger');
const alertService = require('./alertService');

// Chaves sensíveis lidas diretamente do ambiente — protegidas, nunca
// expostas via config/snapshot/log.
const REST_URL = process.env.UPSTASH_REDIS_REST_URL || '';
const REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';

const NS = 'sventv';

let _client = null;
let _availableCache = { value: null, expiresAt: 0 };

const DECR_NON_NEGATIVE_LUA = `
  local v = redis.call('DECR', KEYS[1])
  if v < 0 then
    redis.call('SET', KEYS[1], '0')
    v = 0
  end
  return v
`;

function configured() {
  return Boolean(REST_URL && REST_TOKEN);
}

/**
 * Singleton do cliente Upstash Redis (lazy). Retorna null se não configurado.
 */
function getRedisClient() {
  if (!configured()) return null;
  if (!_client) {
    _client = new Redis({
      url: REST_URL,
      token: REST_TOKEN,
      // Não logar o token em nenhum erro levantado pela lib.
      enableAutoPipelining: false,
    });
  }
  return _client;
}

/**
 * Nome gera chave com namespace do projeto.
 * Ex.: makeKey('rl', 'global', 'user:x'). O projeto inteiro convive no
 * mesmo Upstash sem colidir com outras apps.
 */
function makeKey(...parts) {
  return [NS, ...parts.map((p) => String(p))].join(':');
}

/**
 * Estado de disponibilidade com cache curto.
 * Retorna true → Redis operacional. false → falha/config ausente/kill switch.
 */
async function isRedisAvailable() {
  if (!config.redis.distributedEnabled) return false;
  if (!configured()) return false;

  const now = Date.now();
  if (now < _availableCache.expiresAt && _availableCache.value !== null) {
    return _availableCache.value;
  }

  const client = getRedisClient();
  if (!client) {
    _availableCache = { value: false, expiresAt: now + config.redis.availabilityCacheMs };
    return false;
  }

  try {
    await client.ping();
    _availableCache = { value: true, expiresAt: now + config.redis.availabilityCacheMs };
    return true;
  } catch (err) {
    _availableCache = { value: false, expiresAt: now + config.redis.availabilityCacheMs };
    logger.warn(`Redis indisponível (ping) — fallback em memória: ${err && err.message}`);
    // Alerta operacional (fire-and-forget; debounce por evento). NÃO dispara
    // quando o kill switch/ausência de config causou o false — só falha real.
    alertService.notify('redis.memory_fallback', { context: 'isRedisAvailable' });
    return false;
  }
}

/**
 * Incremento atômico de um contador com TTL.
 *
 * Estratégia SET NX EX (primeira ocorrência define o TTL) + INCR — livre de
 * corrida para janela fixa: a primeira chamada cria a chave com expiração e
 * as demais apenas incrementam (a chave expirada some e o ciclo reinicia).
 *
 * @param {string} key      chave já com namespace (ex.: rl:global:user:x)
 * @param {number} windowMs janela/expiração em milissegundos
 * @returns {Promise<number>} valor após o incremento (1 na primeira chamada)
 * @throws {Error} se o Redis falhar (o chamador decide o fallback)
 */
async function incrWithTTL(key, windowMs) {
  const client = getRedisClient();
  if (!client) throw new Error('redis-not-configured');

  const seconds = Math.max(1, Math.ceil(windowMs / 1000));
  const isNew = await client.set(key, 1, { ex: seconds, nx: true });
  if (isNew !== null) return 1;

  const count = await client.incr(key);
  return typeof count === 'number' ? count : 1;
}

/**
 * Decremento atômico com proteção contra valores negativos.
 * Idempotente em excesso: chamadas além de zero devolvem 0 (nunca gera
 * "slot fantasma" nem consumível futuro).
 *
 * @returns {Promise<number>} valor após o decremento (>= 0)
 * @throws {Error} se o Redis falhar (o chamador decide o fallback)
 */
async function decr(key) {
  const client = getRedisClient();
  if (!client) throw new Error('redis-not-configured');

  const res = await client.eval(DECR_NON_NEGATIVE_LUA, [key], []);
  return typeof res === 'number' ? Math.max(0, res) : 0;
}

const INCR_WINDOW_LUA = `
  local count = redis.call('INCR', KEYS[1])
  local rtKey = KEYS[2]
  local windowMs = tonumber(ARGV[1])
  local now = tonumber(ARGV[2])
  if count == 1 then
    redis.call('PEXPIRE', KEYS[1], windowMs)
    local rt = now + windowMs
    redis.call('SET', rtKey, tostring(rt), 'PX', windowMs)
    return { count, rt }
  end
  local rt = redis.call('GET', rtKey)
  if not rt then
    rt = now + windowMs
  end
  return { count, tonumber(rt) }
`;

/**
 * Incremento atômico de janela fixa devolvendo também o instante de reset.
 * Compatível com a interface de store do express-rate-limit v8
 * ({ totalHits, resetTime }) sem custo extra de rota.
 *
 * @param {string} key      chave já com namespace
 * @param {number} windowMs janela/expiração em milissegundos
 * @returns {Promise<{totalHits: number, resetTime: Date}>}
 * @throws {Error} se o Redis falhar (o chamador decide o fallback)
 */
async function incrWindow(key, windowMs) {
  const client = getRedisClient();
  if (!client) throw new Error('redis-not-configured');

  const now = Date.now();
  const res = await client.eval(INCR_WINDOW_LUA, [key, `${key}:rt`], [windowMs, now]);
  const count = Array.isArray(res) ? res[0] : res;
  const resetTime = Array.isArray(res) ? res[1] : now + windowMs;
  return {
    totalHits: typeof count === 'number' ? count : 1,
    resetTime: new Date(typeof resetTime === 'number' ? resetTime : now + windowMs),
  };
}

/**
 * SET idempotente com TTL (ex.: marcadores de estado do "Avise-me"). A chave
 * é sobrescrita em toda chamada — vale para estados que só precisam existir
 * por um tempo (janela do programa + margem), não para contadores.
 *
 * Fail-open: sem client/configurado ou falha de rede → retorna false (o
 * chamador decide o fallback). NUNCA lança para o consumidor.
 *
 * @param {string} key  chave já com namespace (ex.: sventv:rem:active:...)
 * @param {string} value valor a armazenar
 * @param {number} ttlMs vida útil (ms, mínimo 1s)
 * @returns {Promise<boolean>} true quando gravado no Redis
 */
async function setWithTTL(key, value, ttlMs) {
  const client = getRedisClient();
  if (!client) return false;
  const seconds = Math.max(1, Math.ceil((Number(ttlMs) || 60_000) / 1000));
  try {
    await client.set(key, String(value ?? ''), { ex: seconds });
    return true;
  } catch (err) {
    logger.warn(`Redis setWithTTL falhou (key dentro do namespace de ${NS}): ${err && err.message}`);
    // Alerta operacional fire-and-forget; NÃO dispara quando o false veio de
    // kill switch/ausência de config (nesse caso getRedisClient() retorna null).
    alertService.notify('redis.memory_fallback', { context: 'setWithTTL' });
    return false;
  }
}

async function get(key) {
  const client = getRedisClient();
  if (!client) return null;
  return client.get(key);
}

async function del(key) {
  const client = getRedisClient();
  if (!client) return 0;
  const res = await client.del(key);
  return typeof res === 'number' ? res : 0;
}

/**
 * Reseta o cache de disponibilidade (usado em testes e em pontos onde uma
 * falha transitória recém-cacheada precisa ser reavaliada imediatamente).
 */
function resetAvailabilityCache() {
  _availableCache = { value: null, expiresAt: 0 };
}

module.exports = {
  getRedisClient,
  isRedisAvailable,
  incrWithTTL,
  incrWindow,
  decr,
  setWithTTL,
  get,
  del,
  makeKey,
  resetAvailabilityCache,
};