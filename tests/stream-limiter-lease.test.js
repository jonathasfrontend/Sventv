'use strict';

/**
 * Regressão do "Limite de streams atingido" indevido.
 *
 * Dois defeitosopolitanos interrelated:
 *  1. `acquireSlot` devolvia boolean e `releaseSlot(req)` DECIDIA O BACKEND DE
 *     NOVO. Se a disponibilidade do Redis mudasse entre acquire e release, o
 *     INCR acontecia no Redis e o release caía no Map em memória (vazio): a
 *     vaga ficava presa até o TTL. Agora o acquire devolve um lease e o
 *     release desfaz exatamente onde o acquire somou.
 *  2. O TTL só era aplicado no primeiro `SET NX` (`incrWithTTL`), então uma
 *     sessão longa veria a chave expirar no meio da reprodução. O lease ativo
 *     renova a janela; vaga abandonada não é renovada e expira sozinha.
 *
 * Redis é isolado via require.cache (mesmo padrão dos outros testes).
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const REDIS_PATH = require.resolve('../src/services/redisStore');
const LIMITER_PATH = require.resolve('../src/middlewares/streamLimiter');
const CONFIG_PATH = require.resolve('../src/config/app');
const METRICS_PATH = require.resolve('../src/utils/metrics');
const LOGGER_PATH = require.resolve('../src/utils/logger');

// ── Redis falso ───────────────────────────────────────────────

// Espelha a janela do incrWithTTL real: TTL definido só na criação (SET NX).
function makeFakeRedis({ available = true } = {}) {
  const keys = new Map(); // key -> { value, expiresAt }
  const calls = { pexpire: 0, pexpireMisses: 0 };

  const alive = (k) => {
    const e = keys.get(k);
    if (!e) return null;
    if (Date.now() >= e.expiresAt) {
      keys.delete(k);
      return null;
    }
    return e;
  };

  const client = {
    async get(k) {
      const e = alive(k);
      return e ? String(e.value) : null;
    },
    async set(k, v, opts) {
      if (opts && opts.nx && alive(k)) return null;
      keys.set(k, { value: Number(v), expiresAt: opts && opts.px ? Date.now() + opts.px : Infinity });
      return 'OK';
    },
    async pexpire(k, ms) {
      calls.pexpire++;
      const e = alive(k);
      if (!e) {
        calls.pexpireMisses++;
        return 0;
      }
      e.expiresAt = Date.now() + ms;
      return 1;
    },
    async pexpireat(k, ts) {
      return client.pexpire(k, Math.max(0, ts - Date.now()));
    },
    async del(k) {
      return keys.delete(k) ? 1 : 0;
    },
    async incrby(k, n) {
      const e = alive(k) || { value: 0, expiresAt: Infinity };
      e.value += n;
      keys.set(k, e);
      return e.value;
    },
    async incr(k) {
      return client.incrby(k, 1);
    },
    async decr(k) {
      return client.incrby(k, -1);
    },
    async quit() {},
  };

  return {
    client,
    keys,
    calls,
    isRedisAvailable: async () => available,
    incrWithTTL: async (k, ttl) => {
      const r = await client.incrby(k, 1);
      // SET NX: TTL só na criação.
      if (r === 1) await client.pexpire(k, ttl);
      return r;
    },
    // Espelha `decrWithClamp` (Lua DECR_NON_NEGATIVE_LUA do store real):
    // release repetido não pode deixar o contador negativo.
    decr: async (k) => {
      const e = alive(k);
      if (!e) return 0;
      e.value = Math.max(0, e.value - 1);
      return e.value;
    },
    expire: async (k, ms) => {
      const r = await client.pexpire(k, ms);
      return r === 1;
    },
    resetAvailabilityCache() {},
    makeKey: (...p) => p.join(':'),
  };
}

let redis;
let limiter;

function loadLimiter(redisAvailable) {
  redis = makeFakeRedis({ available: redisAvailable });

  for (const [p, mod] of [
    [REDIS_PATH, redis],
    [CONFIG_PATH, { redis: { slotTtlMs: 300000 } }],
    [METRICS_PATH, { inc: () => {} }],
    [LOGGER_PATH, { warn: () => {}, info: () => {}, error: () => {} }],
  ]) {
    require.cache[p] = { id: p, filename: p, loaded: true, exports: mod };
  }

  delete require.cache[LIMITER_PATH];
  limiter = require(LIMITER_PATH);
  return limiter;
}

const req = (id) => ({ user: { id } });

// ── Contrato de par ───────────────────────────────────────────

test('acquireSlot devolve um lease (não boolean) e releaseSlot o consome', async () => {
  loadLimiter(true);
  const lease = await limiter.acquireSlot(req('u1'));

  assert.ok(lease, 'deve conceder a vaga');
  assert.equal(typeof lease, 'object');
  assert.equal(lease.backend, 'redis');
  assert.ok(lease.rkey, 'lease precisa do rkey para desfazer no Redis');
  assert.notEqual(limiter.acquireSlot, limiter.releaseSlot);
});

test('releaseSlot(null) é no-op seguro (nunca lança)', async () => {
  loadLimiter(true);
  await assert.doesNotReject(() => limiter.releaseSlot(null));
  await assert.doesNotReject(() => limiter.releaseSlot(undefined));
});

test('acquire + release no Redis: contador volta a 0 (sem vazamento)', async () => {
  loadLimiter(true);
  for (let i = 0; i < 4; i++) {
    const lease = await limiter.acquireSlot(req('u2'));
    assert.ok(lease, `tentativa ${i + 1} deveria ser concedida`);
    await limiter.releaseSlot(lease);
  }
  const k = [...redis.keys.keys()][0];
  assert.equal(redis.keys.get(k).value, 0, 'vaga ficou presa no Redis');
});

test('o release desfaz no MESMO backend que concedeu, mesmo se o Redis cair', async () => {
  loadLimiter(true);
  const lease = await limiter.acquireSlot(req('u3'));
  assert.equal(lease.backend, 'redis');

  // Redis "indisponível" entre acquire e release: antes isso descartava a
  // liberação (Map vazio) e a vaga ficava presa até o TTL.
  redis.isRedisAvailable = async () => false;
  await limiter.releaseSlot(lease);

  const k = [...redis.keys.keys()][0];
  assert.equal(redis.keys.get(k).value, 0, 'vaga presa: release não atingiu o Redis');
});

// ── Limite ────────────────────────────────────────────────────

test('STREAM_MAX_ACTIVE padrão é 3 (HLS.js sobrepõe requisições; 1 tranca o usuário)', () => {
  const saved = process.env.STREAM_MAX_ACTIVE;
  delete process.env.STREAM_MAX_ACTIVE;
  loadLimiter(true);
  assert.equal(limiter.ACTIVE_DEFAULT, 3);
  if (saved !== undefined) process.env.STREAM_MAX_ACTIVE = saved;
});

test('respeita STREAM_MAX_ACTIVE do ambiente', () => {
  const saved = process.env.STREAM_MAX_ACTIVE;
  process.env.STREAM_MAX_ACTIVE = '7';
  loadLimiter(true);
  assert.equal(limiter.ACTIVE_DEFAULT, 7);
  if (saved !== undefined) process.env.STREAM_MAX_ACTIVE = saved;
  else delete process.env.STREAM_MAX_ACTIVE;
});

test('concede até ACTIVE_DEFAULT e recusa a vaga seguinte (null, não false)', async () => {
  loadLimiter(true);
  const max = limiter.ACTIVE_DEFAULT;

  for (let i = 0; i < max; i++) {
    assert.ok(await limiter.acquireSlot(req('u4')), `vaga ${i + 1} deveria passar`);
  }
  assert.equal(await limiter.acquireSlot(req('u4')), null, 'vaga extra precisa ser recusada com null');
});

test('a vaga recusada NÃO deixa resíduo no contador (INCR seguido de DECR)', async () => {
  loadLimiter(true);
  const max = limiter.ACTIVE_DEFAULT;
  for (let i = 0; i < max; i++) await limiter.acquireSlot(req('u5'));

  for (let i = 0; i < 5; i++) assert.equal(await limiter.acquireSlot(req('u5')), null);

  const k = [...redis.keys.keys()][0];
  assert.equal(redis.keys.get(k).value, max, 'recusas sucessivas inflaram o contador');
});

test('liberar uma vaga reabre espaço para a mesma conta', async () => {
  loadLimiter(true);
  const max = limiter.ACTIVE_DEFAULT;
  const leases = [];
  for (let i = 0; i < max; i++) leases.push(await limiter.acquireSlot(req('u6')));
  assert.equal(await limiter.acquireSlot(req('u6')), null);

  await limiter.releaseSlot(leases.pop());
  assert.ok(await limiter.acquireSlot(req('u6')), 'deveria liberar após o release');
});

test('limite é por usuário: outra conta não é afetada', async () => {
  loadLimiter(true);
  const max = limiter.ACTIVE_DEFAULT;
  for (let i = 0; i < max; i++) await limiter.acquireSlot(req('u7'));
  assert.equal(await limiter.acquireSlot(req('u7')), null);
  assert.ok(await limiter.acquireSlot(req('u8')), 'usuário diferente tem o próprio orçamento');
});

test('release repetido é idempotente e nunca deixa contador negativo', async () => {
  loadLimiter(true);
  const lease = await limiter.acquireSlot(req('u9'));
  await limiter.releaseSlot(lease);
  await limiter.releaseSlot(lease);
  await limiter.releaseSlot(lease);

  const k = [...redis.keys.keys()][0];
  assert.ok(redis.keys.get(k).value >= 0, 'contador ficou negativo');
});

// ── TTL / self-heal ──────────────────────────────────────────

test('lease concedido renova o TTL (janela corrente durante a reprodução)', async () => {
  loadLimiter(true);
  const before = redis.calls.pexpire;
  const lease = await limiter.acquireSlot(req('u10'));
  assert.ok(lease);
  assert.ok(redis.calls.pexpire > before, 'pexpire deveria renovar a janela do lease');
});

test('tentativa recusada NÃO renova TTL (vaga abandonada expira sozinha)', async () => {
  loadLimiter(true);
  const max = limiter.ACTIVE_DEFAULT;
  for (let i = 0; i < max; i++) await limiter.acquireSlot(req('u11'));

  const before = redis.calls.pexpire;
  for (let i = 0; i < 4; i++) await limiter.acquireSlot(req('u11'));
  assert.equal(redis.calls.pexpire, before, 'recusa não pode prorrogar uma vaga perdida');
});

test('vaga vazada (sem release) se recupera pela expiração do TTL', async () => {
  loadLimiter(true);
  const max = limiter.ACTIVE_DEFAULT;

  for (let i = 0; i < max; i++) await limiter.acquireSlot(req('u12'));
  assert.equal(await limiter.acquireSlot(req('u12')), null, 'deve estar bloqueado');

  // Simula o TTL expirando: a chave some e o contador zera.
  for (const k of [...redis.keys.keys()]) redis.keys.delete(k);

  assert.ok(await limiter.acquireSlot(req('u12')), 'após o TTL o usuário volta a poder assistir');
});

// ── Fallback de memória ───────────────────────────────────────

test('sem Redis, o par funciona em memória e devolve lease backend=mem', async () => {
  loadLimiter(false);
  const lease = await limiter.acquireSlot(req('u13'));

  assert.ok(lease);
  assert.equal(lease.backend, 'mem');
  assert.ok(lease.key);
  assert.equal(redis.calls.pexpire, 0, 'não deve tocar o Redis indisponível');
});

test('sem Redis, o limite em memória vale e o release devolve a vaga', async () => {
  loadLimiter(false);
  const max = limiter.ACTIVE_DEFAULT;

  const leases = [];
  for (let i = 0; i < max; i++) {
    const l = await limiter.acquireSlot(req('u14'));
    assert.ok(l, `vaga ${i + 1} deveria passar`);
    leases.push(l);
  }
  assert.equal(await limiter.acquireSlot(req('u14')), null);

  await limiter.releaseSlot(leases.pop());
  assert.ok(await limiter.acquireSlot(req('u14')));
});

test('chave de usuário ausente cai para o IP (anônimo não compartilha conta)', async () => {
  loadLimiter(false);
  const lease = await limiter.acquireSlot({ ip: '1.2.3.4' });
  assert.ok(lease);
  assert.ok(String(lease.key).includes('1.2.3.4'), `chave deveria conter o IP: ${lease.key}`);
});
