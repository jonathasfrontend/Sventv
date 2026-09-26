'use strict';

/**
 * IpBlocklistService (src/services/ipBlocklistService.js): cache curto com
 * read-through, write-through de block/unblock e fail-open — com repositório
 * INJETADO (DI), sem tocar o banco real (padrão dos testes de serviço).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const IpBlocklistService = require('../src/services/ipBlocklistService');

function fakeRepo(overrides = {}) {
  const calls = { findActive: [], block: [], unblock: [], loadActive: [] };
  const repo = {
    calls,
    async findActive(ip) { calls.findActive.push(ip); return overrides.findActive ? overrides.findActive(ip) : null; },
    async block(args) { calls.block.push(args); return overrides.block ? overrides.block(args) : { ip: args.ip, active: true }; },
    async unblock(args) { calls.unblock.push(args); return overrides.unblock ? overrides.unblock(args) : { ip: args.ip, active: false }; },
    async loadActive() { calls.loadActive.push(true); return overrides.loadActive ? overrides.loadActive() : []; },
    async countActive() { return 0; },
  };
  return repo;
}

let t = Date.now();
const now = () => t;
const TTL = 10_000;

function makeService(repo, enabled = true) {
  return new IpBlocklistService({ enabled, repository: repo, cacheTtlMs: TTL, now });
}

test('isBlocked: cache hit após read-through (1 query por TTL)', async () => {
  const repo = fakeRepo({ findActive: (ip) => ({ ip, active: true, reason: 'abuso', blockedBy: 'a@x.com', blockedAt: new Date() }) });
  const svc = makeService(repo);
  assert.equal(await svc.isBlocked('203.0.113.5'), true);
  assert.equal(await svc.isBlocked('203.0.113.5'), true);
  assert.equal(await svc.isBlocked('203.0.113.5'), true);
  assert.equal(repo.calls.findActive.length, 1, 'deve consultar o banco UMA vez dentro do TTL');
});

test('isBlocked: re-consulta após expirar o TTL', async () => {
  const repo = fakeRepo({ findActive: () => null });
  const svc = makeService(repo);
  assert.equal(await svc.isBlocked('203.0.113.5'), false);
  t += TTL + 1;
  assert.equal(await svc.isBlocked('203.0.113.5'), false);
  assert.equal(repo.calls.findActive.length, 2, 'TTL expirado deve re-consultar');
});

test('isBlocked: IP inválido nunca toca o repositório', async () => {
  const repo = fakeRepo();
  const svc = makeService(repo);
  assert.equal(await svc.isBlocked('xablau'), false);
  assert.equal(await svc.isBlocked(''), false);
  assert.equal(await svc.isBlocked(null), false);
  assert.equal(repo.calls.findActive.length, 0);
});

test('isBlocked: kill switch desligado → sempre liberado', async () => {
  const repo = fakeRepo();
  const svc = makeService(repo, false);
  svc.restore([{ ip: '203.0.113.5', active: true, reason: '', blockedBy: null, blockedAt: new Date() }]);
  assert.equal(await svc.isBlocked('203.0.113.5'), false);
  assert.equal(repo.calls.findActive.length, 0);
});

test('isBlocked: fail-open — banco fora não lança e libera acesso', async () => {
  const repo = fakeRepo({ findActive: () => { throw new Error('connection refused'); } });
  const svc = makeService(repo);
  assert.equal(await svc.isBlocked('203.0.113.5'), false);
});

test('block: aplica em memória imediatamente + persiste write-through', async () => {
  const repo = fakeRepo();
  const svc = makeService(repo);
  await svc.block('::ffff:203.0.113.7', { reason: ' flood ', blockedBy: 'admin@x.com' });
  assert.equal(svc.peek('203.0.113.7'), true, 'bloqueio efetivo já no cache (IPv4-mapped normalizado)');
  assert.equal(repo.calls.block.length, 1);
  assert.deepEqual(repo.calls.block[0], { ip: '203.0.113.7', reason: 'flood', blockedBy: 'admin@x.com' });
});

test('block: IP inválido → erro 422, nada é persistido', async () => {
  const repo = fakeRepo();
  const svc = makeService(repo);
  await assert.rejects(() => svc.block('nao-eh-ip'), (err) => err.statusCode === 422);
  assert.equal(repo.calls.block.length, 0);
});

test('block: kill switch → não persiste, mas bloqueia na instância', async () => {
  const repo = fakeRepo();
  const svc = makeService(repo, false);
  const out = await svc.block('203.0.113.8');
  assert.equal(out.active, true);
  assert.equal(svc.peek('203.0.113.8'), true);
  assert.equal(repo.calls.block.length, 0);
});

test('unblock: remove do cache e persiste', async () => {
  const repo = fakeRepo();
  const svc = makeService(repo);
  await svc.block('203.0.113.9');
  await svc.unblock('203.0.113.9', { unblockedBy: 'admin@x.com' });
  assert.equal(svc.peek('203.0.113.9'), false);
  assert.equal(repo.calls.unblock.length, 1);
  assert.deepEqual(repo.calls.unblock[0], { ip: '203.0.113.9', unblockedBy: 'admin@x.com' });
});

test('unblock: P2025 (linha inexistente) é engolido — idempotente', async () => {
  const P2025 = Object.assign(new Error('Record not found'), { code: 'P2025' });
  const repo = fakeRepo({ unblock: () => { throw P2025; } });
  const svc = makeService(repo);
  const out = await svc.unblock('203.0.113.10');
  assert.equal(out.active, false);
});

test('unblock: erro real de persistência não lança (métrica)', async () => {
  const repo = fakeRepo({ unblock: () => { throw new Error('boom'); } });
  const svc = makeService(repo);
  await svc.unblock('203.0.113.11'); // não deve rejeitar
});

test('ensureLoaded: hidrata o cache em uma query e devolve a contagem', async () => {
  const repo = fakeRepo({
    loadActive: () => [
      { ip: '203.0.113.5', active: true, reason: 'a', blockedBy: null, blockedAt: new Date() },
      { ip: '203.0.113.6', active: true, reason: 'b', blockedBy: 'x@y.z', blockedAt: new Date() },
    ],
  });
  const svc = makeService(repo);
  const n = await svc.ensureLoaded();
  assert.equal(n, 2);
  assert.equal(svc.peek('203.0.113.5'), true);
  assert.equal(svc.peek('203.0.113.6'), true);
  assert.equal(repo.calls.loadActive.length, 1);
});

test('ensureLoaded: falha no banco → 0 e nunca rejeita', async () => {
  const repo = fakeRepo({ loadActive: () => { throw new Error('down'); } });
  const svc = makeService(repo);
  assert.equal(await svc.ensureLoaded(), 0);
});

test('restore: entradas inativas são ignoradas', async () => {
  const svc = makeService(fakeRepo());
  svc.restore([{ ip: '203.0.113.5', active: false, reason: '', blockedBy: null, blockedAt: new Date() }]);
  assert.equal(svc.peek('203.0.113.5'), false);
});

test('all: lista entradas em cache incluindo bloqueadas', async () => {
  const svc = makeService(fakeRepo());
  await svc.block('203.0.113.12', { reason: 'spam' });
  const entries = svc.all();
  const entry = entries.find((e) => e.ip === '203.0.113.12');
  assert.ok(entry && entry.active === true && entry.reason === 'spam');
});

test('normalização: bloco aplicado em IPv4-mapped bloqueia o IPv4 equivalente', async () => {
  const repo = fakeRepo();
  const svc = makeService(repo);
  await svc.block('::ffff:198.51.100.4');
  assert.equal(svc.peek('198.51.100.4'), true, 'mesma chave canônica após normalização');
});