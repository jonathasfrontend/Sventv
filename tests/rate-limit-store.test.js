'use strict';

const { test, mock } = require('node:test');
const assert = require('node:assert/strict');

const { RedisRateLimitStore } = require('../src/middlewares/rateLimiter');
const redisStore = require('../src/services/redisStore');
const metrics = require('../src/utils/metrics');

// Simula Redis indisponível: força o fallback em memória (sem rede).
function withRedisDown(fn) {
  mock.method(redisStore, 'isRedisAvailable', async () => false);
  try {
    return fn();
  } finally {
    redisStore.isRedisAvailable.mock.restore();
  }
}

test('store híbrido com Redis down usa memória e conta corretamente', async () => {
  await withRedisDown(async () => {
    const store = new RedisRateLimitStore({ context: 'teste', windowMs: 60000 });
    const r1 = await store.increment('k1');
    const r2 = await store.increment('k1');
    assert.equal(r1.totalHits, 1);
    assert.equal(r2.totalHits, 2);
    assert.ok(r1.resetTime instanceof Date);
    assert.ok(r1.resetTime.getTime() > Date.now());
  });
});

test('janela expirada zera o contador no fallback', async () => {
  await withRedisDown(async () => {
    const store = new RedisRateLimitStore({ context: 'teste-window', windowMs: 50 });
    await store.increment('k');
    await new Promise((r) => setTimeout(r, 60));
    const r = await store.increment('k');
    assert.equal(r.totalHits, 1);
  });
});

test('decrement e resetKey atuam no fallback', async () => {
  await withRedisDown(async () => {
    const store = new RedisRateLimitStore({ context: 'teste-ops', windowMs: 60000 });
    await store.increment('k');
    await store.increment('k');
    await store.decrement('k');
    assert.equal((await store.increment('k')).totalHits, 2); // 2-1+1
    await store.resetKey('k');
    assert.equal((await store.increment('k')).totalHits, 1);
  });
});

test('contexto distinto gera chaves Redis distintas (não colidem)', () => {
  const a = new RedisRateLimitStore({ context: 'forgot-password', windowMs: 1000 });
  const b = new RedisRateLimitStore({ context: 'reset-password', windowMs: 1000 });
  const key1 = a._redisKey('ip_x');
  const key2 = b._redisKey('ip_x');
  assert.notEqual(key1, key2);
  assert.match(key1, /^sventv:rl:forgot-password:/);
  assert.match(key2, /^sventv:rl:reset-password:/);
});