'use strict';

/**
 * Persistência do estado administrativo de canais (Postgres via
 * channelStateRepository) + read-through com TTL do ChannelStateService:
 *  - Service: cache curto, miss consulta uma única vez, fail-open com banco
 *    fora, ensureLoaded idempotente, restore sem IO;
 *  - Repository: contrato das queries (upsert/delete/loadAll/removeStale);
 *  - Controller: setChannelState grava write-through (upsert p/ != live,
 *    delete p/ live) e é fail-open (200 mesmo com banco fora).
 *
 * O cliente Prisma é Proxy-based → substituição manual com restore em finally
 * (padrão validado em password-reset-repository.test.js / admin-users...).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

// Isolamento (igual admin-users-controller.test.js): ChannelHealthService
// auto-inicia ~91 probes com o m3uService real. Stub no require.cache ANTES
// de importar o controlador.
const HEALTH_PATH = require.resolve('../src/services/channelHealthService');
class FakeHealthService {
  constructor() { this.statuses = new Map(); }
  startAutoChecks() {}
  stopAutoChecks() {}
  async checkChannelById() {
    return { ok: false, checkedAt: null, activeSource: 'primary', primary: null, backup: null };
  }
  async checkAllChannels() { return undefined; }
  getStatuses() { return []; }
  getFailoverInfo() { return null; }
  reportResult() {}
  resolveActiveUrl(ch) { return (ch && (ch.url || ch.primaryUrl)) || null; }
  resolveSourceUrls(ch) { return (ch && [ch.url || ch.primaryUrl].filter(Boolean)) || []; }
}
require.cache[HEALTH_PATH] = {
  id: HEALTH_PATH,
  filename: HEALTH_PATH,
  loaded: true,
  exports: FakeHealthService,
};

// M3U real faria require~ com download em rede; stub com canal fixo.
const M3U_PATH = require.resolve('../src/services/m3uService');
class FakeM3UService {
  static getShared() {
    if (!FakeM3UService._shared) FakeM3UService._shared = new FakeM3UService();
    return FakeM3UService._shared;
  }
  constructor() {
    this.channels = [{ id: 'ch-1', name: 'Canal Teste', category: 'Filmes', format: 'HLS', logo: '', url: '' }];
  }
  getChannelById(id) { return this.channels.find((c) => c.id === id) || null; }
  getAllChannels() { return this.channels; }
  async ensureLoaded() { return this; }
  async reloadChannels() { return this; }
}
FakeM3UService._shared = null;
require.cache[M3U_PATH] = {
  id: M3U_PATH,
  filename: M3U_PATH,
  loaded: true,
  exports: FakeM3UService,
};

const ChannelStateService = require('../src/services/channelStateService');
const channelStateRepository = require('../src/repositories/channelStateRepository');
const prisma = require('../src/prisma/client');
const adminController = require('../src/controllers/adminController');

const { snapshot: metricsSnapshot } = require('../src/utils/metrics');

// ── Service: read-through com TTL ─────────────────────────────

function makeRepo(rows = new Map()) {
  const calls = { loadAll: 0, getState: [], upsert: 0, reset: 0, deleteMany: 0 };
  return {
    calls,
    rows,
    async loadAll() { calls.loadAll += 1; return Array.from(rows.values()); },
    async getState(id) { calls.getState.push(id); return rows.get(id) || null; },
    async upsertState() { calls.upsert += 1; },
    async resetState(id) { calls.reset += 1; rows.delete(id); },
    async removeStale() { calls.deleteMany += 1; return 0; },
    seed(id, row) { rows.set(id, { channelId: id, state: 'live', reason: '', setBy: null, updatedAt: new Date(0).toISOString(), ...row }); },
  };
}

function makeService(repo, ttl = 100) {
  let now = 0;
  const svc = new ChannelStateService({ persistEnabled: true, repository: repo, cacheTtlMs: ttl, now: () => now });
  return { svc, advance(ms) { now += ms; } };
}

test('service: miss sem cache consulta exatamente uma vez e hidrata o cache', async () => {
  const repo = makeRepo();
  repo.seed('ch-1', { state: 'blocked', reason: 'copyright', setBy: 'adm@x' });
  const { svc } = makeService(repo);

  assert.equal(await svc.get('ch-1'), 'blocked');
  assert.deepEqual(repo.calls.getState, ['ch-1']);
  // dento do TTL → hit, sem nova consulta
  assert.equal(await svc.get('ch-1'), 'blocked');
  assert.equal(repo.calls.getState.length, 1);
});

test('service: após expirar o TTL, faz refresh (propagação entre instâncias)', async () => {
  const repo = makeRepo();
  repo.seed('ch-1', { state: 'maintenance' });
  const { svc, advance } = makeService(repo);

  assert.equal(await svc.get('ch-1'), 'maintenance');
  assert.equal(repo.calls.getState.length, 1);

  advance(101); // expira
  repo.seed('ch-1', { state: 'live' });
  assert.equal(await svc.get('ch-1'), 'live'); // re-query viu o "reset" feito em outra instância
  assert.equal(repo.calls.getState.length, 2);
});

test('service: sem registro no banco → live (e cache é descartado)', async () => {
  const repo = makeRepo();
  const { svc, advance } = makeService(repo);

  svc.set('ghost', 'blocked'); // memória local != banco
  assert.equal(await svc.get('ghost'), 'blocked'); // hit (cache recém-marcado)
  advance(101);
  assert.equal(await svc.get('ghost'), 'live'); // banco vazio manda (live/default)
  assert.deepEqual(repo.calls.getState, ['ghost']);
});

test('service: fail-open mantém valor em memória quando o banco falha', async () => {
  const repo = makeRepo();
  repo.seed('ch-1', { state: 'blocked' });
  const { svc, advance } = makeService(repo);

  assert.equal(await svc.get('ch-1'), 'blocked');
  advance(101);
  repo.getState = async () => { throw new Error('banco fora'); };
  assert.equal(await svc.get('ch-1'), 'blocked'); // fallback p/ memória
  assert.equal(metricsSnapshot().counters.channelStateFallbacks, 1);
});

test('service: fail-open sem memória → live (nunca lança em erro de banco)', async () => {
  const repo = makeRepo();
  repo.getState = async () => { throw new Error('banco fora'); };
  const { svc } = makeService(repo);

  assert.equal(await svc.get('zz'), 'live');
  assert.equal(await svc.entry('zz'), null);
});

test('service: persistEnabled=false nunca consulta o repositório', async () => {
  const repo = makeRepo();
  const mem = new ChannelStateService({ persistEnabled: false, repository: repo, cacheTtlMs: 50 });
  mem.set('x', 'blocked');
  assert.equal(await mem.get('x'), 'blocked'); // memória
  assert.equal(await mem.get('outro'), 'live'); // default sem IO
  assert.deepEqual(repo.calls.getState, []);
});

test('service: entry retorna o entry completo via read-through', async () => {
  const repo = makeRepo();
  repo.seed('ch-1', { state: 'maintenance', reason: 'troca', setBy: 'adm@x', updatedAt: new Date('2026-01-01T00:00:00Z') });
  const { svc } = makeService(repo);

  const entry = await svc.entry('ch-1');
  assert.equal(entry.state, 'maintenance');
  assert.equal(entry.reason, 'troca');
  assert.equal(entry.setBy, 'adm@x');
  assert.equal(new Date(entry.updatedAt).toISOString(), new Date('2026-01-01T00:00:00Z').toISOString());
  assert.equal(await svc.entry('nao-existe'), null);
});

test('service: ensureLoaded hidrata via loadAll e é idempotente (uma query)', async () => {
  const repo = makeRepo();
  repo.seed('e1', { state: 'maintenance', reason: 'ok' });
  repo.seed('e2', { state: 'blocked' });
  const { svc, advance } = makeService(repo);

  const n = await svc.ensureLoaded();
  assert.equal(n, 2);
  assert.equal(repo.calls.loadAll, 1);
  await svc.ensureLoaded();
  assert.equal(repo.calls.loadAll, 1); // memoizado
  assert.equal(await svc.get('e1'), 'maintenance');
  assert.equal(repo.calls.getState.length, 0); // veio do cache hidratado

  advance(101);
  repo.seed('e1', { state: 'live' });
  assert.equal(await svc.get('e1'), 'live'); // refresh respeita o TTL mesmo após hidratação
});

test('service: restore() sem IO e múltiplas chamadas com refresh concorrente não duplicam consulta', async () => {
  const repo = makeRepo();
  repo.seed('ch-1', { state: 'blocked' });
  const { svc } = makeService(repo);

  const [a, b] = await Promise.all([svc.get('ch-1'), svc.get('ch-1')]);
  assert.equal(a, 'blocked');
  assert.equal(b, 'blocked');
  assert.equal(repo.calls.getState.length, 1); // anti-thundering herd
});

test('service: restore ignora estados inválidos', async () => {
  const repo = makeRepo();
  const { svc } = makeService(repo);
  svc.restore([{ channelId: 'bad', state: 'explodido', reason: '', setBy: null, updatedAt: new Date() }]);
  assert.equal(await svc.entry('bad'), null);
});

// ── Repository: contrato Prisma ───────────────────────────────

function withPrismaChannelState(mocks, fn) {
  const saved = {
    'channelState.findMany': prisma.channelState.findMany,
    'channelState.findUnique': prisma.channelState.findUnique,
    'channelState.upsert': prisma.channelState.upsert,
    'channelState.delete': prisma.channelState.delete,
    'channelState.deleteMany': prisma.channelState.deleteMany,
  };
  const set = (path, val) => {
    const parts = path.split('.');
    let obj = prisma;
    for (let i = 0; i < parts.length - 1; i++) obj = obj[parts[i]];
    obj[parts[parts.length - 1]] = val;
  };
  for (const [path, mock] of Object.entries(mocks || {})) set(path, mock);
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [path, orig] of Object.entries(saved)) set(path, orig);
    });
}

test('repo: loadAll mapeia linhas para formato plano do serviço', async () => {
  await withPrismaChannelState(
    {
      'channelState.findMany': async () => [
        { channelId: 'a', state: 'blocked', reason: 'r1', setBy: 'adm', updatedAt: new Date('2026-01-01T00:00:00Z') },
        { channelId: 'b', state: 'maintenance', reason: '', setBy: null, updatedAt: new Date('2026-01-02T00:00:00Z') },
      ],
    },
    async () => {
      const rows = await channelStateRepository.loadAll();
      assert.equal(rows.length, 2);
      assert.equal(rows[0].channelId, 'a');
      assert.equal(rows[0].setBy, 'adm');
      assert.ok(rows[0].updatedAt instanceof Date);
    }
  );
});

test('repo: getState retorna null quando não há registro (estado padrão foi resetado)', async () => {
  await withPrismaChannelState({ 'channelState.findUnique': async () => null }, async () => {
    assert.equal(await channelStateRepository.getState('ghost'), null);
  });
});

test('repo: upsertState grava com where/update/create corretos', async () => {
  let captured = null;
  await withPrismaChannelState(
    {
      'channelState.upsert': async (args) => { captured = args; return { channelId: 'c1' }; },
    },
    async () => {
      await channelStateRepository.upsertState('c1', { state: 'maintenance', reason: 'rel', setBy: 'adm@x' });
      assert.equal(captured.where.channelId, 'c1');
      assert.equal(captured.update.state, 'maintenance');
      assert.equal(captured.update.setBy, 'adm@x');
      assert.equal(captured.create.channelId, 'c1');
      assert.equal(captured.create.state, 'maintenance');
    }
  );
});

test('repo: resetState (live) apaga; P2025 (já inexistente) é não-erro; outro erro propaga', async () => {
  await withPrismaChannelState(
    { 'channelState.delete': async () => { const e = new Error('not found'); e.code = 'P2025'; throw e; } },
    async () => {
      assert.equal(await channelStateRepository.resetState('ghost'), null); // não lança
    }
  );
  await withPrismaChannelState(
    { 'channelState.delete': async () => { throw new Error('timeout'); } },
    async () => {
      await assert.rejects(() => channelStateRepository.resetState('c1'), /timeout/);
    }
  );
});

test('repo: removeStale retorna 0 com lista vazia e chama deleteMany.notIn caso contrário', async () => {
  let captured = null;
  await withPrismaChannelState(
    {
      'channelState.deleteMany': async (args) => { captured = args; return { count: 3 }; },
    },
    async () => {
      assert.equal(await channelStateRepository.removeStale([]), 0);
      assert.equal(captured, null); // não chamou o banco
      const n = await channelStateRepository.removeStale(['a', 'b', 'c']);
      assert.equal(n, 3);
      assert.deepEqual(captured.where.channelId.notIn, ['a', 'b', 'c']);
    }
  );
});

// ── Controller: write-through no setChannelState ──────────────

function spyRes() {
  const res = { statusCode: null, jsonBody: null, sent: false };
  res.status = function (code) { this.statusCode = code; return this; };
  res.json = function (body) { this.jsonBody = body; this.sent = true; return this; };
  return res;
}

const ADMIN = { id: 'adm-1', name: 'Root', email: 'root@example.com', role: 'admin', status: 'active' };

function withPrismaMocks(mocks, fn) {
  const saved = ['channelState.upsert', 'channelState.delete', 'auditLog.create'].map((path) => {
    const parts = path.split('.');
    let obj = prisma;
    for (let i = 0; i < parts.length - 1; i++) obj = obj[parts[i]];
    return [path, obj[parts[parts.length - 1]], parts, obj];
  });
  const set = (parts, val) => {
    let obj = prisma;
    for (let i = 0; i < parts.length - 1; i++) obj = obj[parts[i]];
    obj[parts[parts.length - 1]] = val;
  };
  set(['auditLog', 'create'], async () => ({}));
  for (const [path, mock] of Object.entries(mocks || {})) set(path.split('.'), mock);
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [path, orig, parts] of saved) set(parts, orig);
    });
}

test('setChannelState: blocked → upsert persistido (write-through) e resposta 200', async () => {
  let upsertArgs = null;
  await withPrismaMocks(
    { 'channelState.upsert': async (args) => { upsertArgs = args; return { channelId: 'ch-1' }; } },
    async () => {
      const res = spyRes();
      await adminController.setChannelState(
        { params: { channelId: 'ch-1' }, body: { state: 'blocked', reason: 'copyright DMCA' }, user: ADMIN },
        res,
        () => {}
      );
      assert.equal(res.statusCode, 200);
      assert.equal(res.jsonBody.data.state, 'blocked');
      assert.equal(upsertArgs.where.channelId, 'ch-1');
      assert.equal(upsertArgs.create.state, 'blocked');
      assert.equal(upsertArgs.create.reason, 'copyright DMCA');
      assert.equal(upsertArgs.create.setBy, 'root@example.com');
      assert.equal(res.jsonBody.data.reason, 'copyright DMCA');
    }
  );
});

test('setChannelState: live → apaga o registro (delete), nunca upsert', async () => {
  let deleted = null;
  let upsertCalled = false;
  await withPrismaMocks(
    {
      'channelState.upsert': async () => { upsertCalled = true; return null; },
      'channelState.delete': async (args) => { deleted = args; return { channelId: 'ch-1' }; },
    },
    async () => {
      const res = spyRes();
      await adminController.setChannelState({ params: { channelId: 'ch-1' }, body: { state: 'live' }, user: ADMIN }, res, () => {});
      assert.equal(res.statusCode, 200);
      assert.equal(res.jsonBody.data.state, 'live');
      assert.equal(deleted.where.channelId, 'ch-1');
      assert.equal(upsertCalled, false);
    }
  );
});

test('setChannelState: falha de persistência é fail-open (200, estado aplicado em memória)', async () => {
  const beforeCount = metricsSnapshot().counters.channelStatePersistenceFailures;
  await withPrismaMocks(
    { 'channelState.upsert': async () => { throw new Error('pg timeout'); } },
    async () => {
      const res = spyRes();
      await adminController.setChannelState({ params: { channelId: 'ch-1' }, body: { state: 'maintenance', reason: 'x' }, user: ADMIN }, res, () => {});
      assert.equal(res.statusCode, 200);
      assert.equal(res.jsonBody.data.state, 'maintenance');
      assert.equal(metricsSnapshot().counters.channelStatePersistenceFailures, beforeCount + 1);
    }
  );
});