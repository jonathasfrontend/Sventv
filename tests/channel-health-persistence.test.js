'use strict';

/**
 * Persistência do failover de canais (channel_health):
 *  - service: transições gravam upsert; checagens SEM troca fazem ZERO
 *    escritas; ensureLoaded restaura só o activeSource (counters em memória
 *    zerados) e é idempotente/fail-open; kill switch → 100% memória;
 *  - repository: contrato Prisma (loadAll/getHealth/upsertHealth/resetHealth/
 *    removeStale);
 *  - alertas: failover/failback notificam 'channelHealth.failover/failback'
 *    (fire-and-forget, debounce — nunca derruba o ciclo);
 *  - singleton: getShared() devolve a mesma instância.
 *
 * Nota: transições aqui usam repos/temporada FAKES — nunca tocam o Postgres
 * (unidade em isolamento; o contrato do repositório está mockado abaixo).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const ChannelHealthService = require('../src/services/channelHealthService');
const channelHealthRepository = require('../src/repositories/channelHealthRepository');
const alertService = require('../src/services/alertService');
const prisma = require('../src/prisma/client');
const config = require('../src/config/app');
const { snapshot: metricsSnapshot } = require('../src/utils/metrics');

const channel = {
  id: 'ch1',
  name: 'Canal Teste',
  url: 'http://primary.example/1.m3u8',
  primaryUrl: 'http://primary.example/1.m3u8',
  backupUrl: 'http://backup.example/1.m3u8',
  urls: ['http://primary.example/1.m3u8', 'http://backup.example/1.m3u8'],
};

// ── Fakes ────────────────────────────────────────────────────

function makeRepo() {
  const calls = { loadAll: 0, upsertHealth: 0, upserts: [] };
  const rows = new Map();
  const repo = {
    calls,
    seed(id, row) { rows.set(id, { channelId: id, activeSource: 'primary', consecutiveFails: 0, lastSwitchAt: null, ...row }); },
    async loadAll() { calls.loadAll += 1; return Array.from(rows.values()); },
    async getHealth(id) { return rows.get(id) || null; },
    async upsertHealth(channelId, data) {
      calls.upsertHealth += 1;
      calls.upserts.push({ channelId, data });
      rows.set(channelId, { channelId, ...data });
      return { channelId, ...data };
    },
    async resetHealth() { return null; },
    async removeStale() { return 0; },
  };
  return repo;
}

function makeSvc(repo, stateFn, opts = {}) {
  const svc = new ChannelHealthService(null, {
    intervalMs: 1000,
    requestTimeout: 100,
    failoverThreshold: 2,
    failbackMinMs: 0,
    minSwitchMs: 0,
    persistEnabled: true,
    repository: repo,
    now: () => 1_775_000_000_000,
    ...opts,
  });
  svc.m3uService = {
    getAllChannels: () => [channel],
    getChannelById: (id) => (id === channel.id ? channel : null),
  };
  svc._checkUrl = async (url) => {
    const state = typeof stateFn === 'function' ? stateFn() : stateFn;
    if (url === channel.url) return state.primary;
    if (url === channel.backupUrl) return state.backup;
    return false;
  };
  return svc;
}

// ── Service: contrato de persistência ────────────────────────

test('health: N checagens sem transição → ZERO escritas no repositório', async () => {
  const repo = makeRepo();
  const svc = makeSvc(repo, { primary: true, backup: true });

  await svc.checkChannel(channel);
  await svc.checkChannel(channel);
  await svc.checkChannel(channel);

  assert.equal(repo.calls.upsertHealth, 0, 'checks rotineiros não gravam');
  assert.equal(svc.getFailoverInfo('ch1').activeSource, 'primary');
});

test('health: failover (primária→backup) grava 1 upsert com activeSource=backup', async () => {
  let state = { primary: false, backup: true };
  const repo = makeRepo();
  const svc = makeSvc(repo, () => state);

  await svc.checkChannel(channel); // 1ª falha (threshold 2 → ainda primária, 0 escritas)
  assert.equal(repo.calls.upsertHealth, 0);
  await svc.checkChannel(channel); // 2ª falha → transição
  assert.equal(repo.calls.upsertHealth, 1);
  assert.equal(svc.getFailoverInfo('ch1').activeSource, 'backup');

  const { data } = repo.calls.upserts[0];
  assert.equal(data.activeSource, 'backup');
  assert.equal(data.consecutiveFails, 0, 'snapshot informativo no momento da troca (backup ok)');
  assert.ok(data.lastSwitchAt instanceof Date, 'lastSwitchAt gravado');
  assert.ok(repo.calls.upserts[0].channelId === 'ch1');

  // continua fora do ar → mesmo ativo, mais N checks → ainda 1 escrita total
  await svc.checkChannel(channel);
  await svc.checkChannel(channel);
  assert.equal(repo.calls.upsertHealth, 1, 'sem troca, sem escrita');
});

test('health: failback (backup→primária) grava 1 upsert com activeSource=primary', async () => {
  let state = { primary: false, backup: true };
  const repo = makeRepo();
  const svc = makeSvc(repo, () => state);

  await svc.checkChannel(channel);
  await svc.checkChannel(channel); // primária→backup (1ª escrita)

  state = { primary: true, backup: false };
  await svc.checkChannel(channel); // backup falha + primária ok → failback (2ª escrita)
  assert.equal(repo.calls.upsertHealth, 2);
  assert.equal(repo.calls.upserts[1].data.activeSource, 'primary');
  assert.equal(svc.getFailoverInfo('ch1').activeSource, 'primary');
});

test('health: falha de persistência é fail-open (transição continua valendo)', async () => {
  let state = { primary: false, backup: true };
  const repo = makeRepo();
  repo.upsertHealth = async () => { throw new Error('pg timeout'); };
  const svc = makeSvc(repo, () => state);

  const before = metricsSnapshot().counters.channelHealthPersistenceFailures;
  await svc.checkChannel(channel);
  await svc.checkChannel(channel);
  assert.equal(svc.getFailoverInfo('ch1').activeSource, 'backup');
  assert.equal(metricsSnapshot().counters.channelHealthPersistenceFailures, before + 1);
});

test('health: ensureLoaded restaura só o activeSource e zera contadores em memória', async () => {
  const repo = makeRepo();
  repo.seed('ch1', {
    activeSource: 'backup',
    consecutiveFails: 7,
    lastSwitchAt: new Date(1_770_000_000_000),
  });
  const svc = makeSvc(repo, { primary: true, backup: true });

  const n = await svc.ensureLoaded();
  assert.equal(n, 1);
  const info = svc.getFailoverInfo('ch1');
  assert.equal(info.activeSource, 'backup');
  assert.equal(info.fails.backup, 0, 'failCount não é restaurado do banco (fica 0)');
  assert.equal(svc.resolveActiveUrl(channel), channel.backupUrl);
  assert.equal(repo.calls.loadAll, 1);
});

test('health: ensureLoaded é idempotente (uma query) e fail-open', async () => {
  const repo = makeRepo();
  repo.seed('ch1', { activeSource: 'backup' });
  const svc = makeSvc(repo, { primary: true, backup: true });

  assert.equal(await svc.ensureLoaded(), 1);
  assert.equal(await svc.ensureLoaded(), 1);
  assert.equal(repo.calls.loadAll, 1);

  const repoFail = makeRepo();
  repoFail.loadAll = async () => { throw new Error('banco fora'); };
  const svc2 = makeSvc(repoFail, { primary: true, backup: true });
  const before = metricsSnapshot().counters.channelHealthPersistenceFailures;
  assert.equal(await svc2.ensureLoaded(), 0, 'nunca lança');
  assert.equal(metricsSnapshot().counters.channelHealthPersistenceFailures, before + 1);
});

test('health: kill switch (persistEnabled=false) → 100% memória, 0 escritas', async () => {
  let state = { primary: false, backup: true };
  const repo = makeRepo();
  const svc = makeSvc(repo, () => state, { persistEnabled: false });

  assert.equal(await svc.ensureLoaded(), 0);
  await svc.checkChannel(channel);
  await svc.checkChannel(channel); // transição acontece em memória
  assert.equal(svc.getFailoverInfo('ch1').activeSource, 'backup');
  assert.equal(repo.calls.upsertHealth, 0);
  assert.equal(repo.calls.loadAll, 0);
});

// ── Alertas ──────────────────────────────────────────────────

const withAlertsConfig = (overrides, fn) => {
  const saved = {
    enabled: config.alerts.enabled,
    cooldownMs: config.alerts.cooldownMs,
    adminEmail: config.alerts.adminEmail,
    webhookUrl: config.alerts.webhookUrl,
  };
  Object.assign(config.alerts, { enabled: true, cooldownMs: 30_000, adminEmail: '', webhookUrl: '', ...overrides });
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      config.alerts.enabled = saved.enabled;
      config.alerts.cooldownMs = saved.cooldownMs;
      config.alerts.adminEmail = saved.adminEmail;
      config.alerts.webhookUrl = saved.webhookUrl;
    });
};

test('health: failover e failback notificam alertService (sem derrubar o ciclo)', async () => {
  await withAlertsConfig({}, async () => {
    const sent = [];
    alertService.resetCooldown();
    alertService._setSinks({
      sendEmail: async (payload) => { sent.push({ kind: 'email', payload }); },
      sendWebhook: async (text) => { sent.push({ kind: 'webhook', text }); },
    });

    let state = { primary: false, backup: true };
    const repo = makeRepo();
    const svc = makeSvc(repo, () => state);

    try {
      await svc.checkChannel(channel);
      await svc.checkChannel(channel); // failover
      assert.ok(sent.some((s) => s.kind === 'webhook' && s.text.includes('channelHealth.failover')),
        'alertou failover no webhook');

      state = { primary: true, backup: false };
      await svc.checkChannel(channel); // failback
      assert.ok(sent.some((s) => s.kind === 'webhook' && s.text.includes('channelHealth.failback')),
        'alertou failback no webhook');
    } finally {
      alertService._setSinks(null);
    }
  });
});

test('alertService: debounce por evento (2ª notificação no cooldown é descartada)', async () => {
  await withAlertsConfig({ cooldownMs: 60_000 }, async () => {
    const webhooks = [];
    alertService.resetCooldown();
    alertService._setSinks({ sendWebhook: async (text) => { webhooks.push(text); } });
    try {
      alertService.notify('evento.teste', { a: 1 });
      alertService.notify('evento.teste', { a: 2 });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(webhooks.length, 1, 'segunda dentro do cooldown é descartada');
      assert.ok(webhooks[0].includes('evento.teste'));
    } finally {
      alertService._setSinks(null);
    }
  });
});

test('alertService: falha de entrega nunca lança (fire-and-forget)', async () => {
  await withAlertsConfig({}, async () => {
    alertService.resetCooldown();
    alertService._setSinks({
      sendWebhook: async () => { throw new Error('webhook fora'); },
    });
    try {
      assert.doesNotThrow(() => alertService.notify('evento.falho', {}));
    } finally {
      alertService._setSinks(null);
    }
  });
});

// ── Singleton ─────────────────────────────────────────────────

test('health: getShared() devolve a MESMA instância (um ciclo por lambda)', () => {
  const a = ChannelHealthService.getShared();
  const b = ChannelHealthService.getShared();
  assert.equal(a, b);
  a.stopAutoChecks();
  ChannelHealthService._shared = null;
});

// ── Repository: contrato Prisma ──────────────────────────────

function withPrismaHealth(mocks, fn) {
  const saved = {
    'channelHealth.findMany': prisma.channelHealth.findMany,
    'channelHealth.findUnique': prisma.channelHealth.findUnique,
    'channelHealth.upsert': prisma.channelHealth.upsert,
    'channelHealth.delete': prisma.channelHealth.delete,
    'channelHealth.deleteMany': prisma.channelHealth.deleteMany,
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

test('repo: loadAll mapeia linhas do channel_health', async () => {
  await withPrismaHealth(
    {
      'channelHealth.findMany': async () => [
        { channelId: 'a', activeSource: 'backup', consecutiveFails: 3, lastSwitchAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date() },
      ],
    },
    async () => {
      const rows = await channelHealthRepository.loadAll();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].channelId, 'a');
      assert.equal(rows[0].activeSource, 'backup');
      assert.equal(rows[0].consecutiveFails, 3);
      assert.ok(rows[0].lastSwitchAt instanceof Date);
    }
  );
});

test('repo: getHealth null quando não há registro; upsertHealth contrato correto', async () => {
  await withPrismaHealth(
    { 'channelHealth.findUnique': async () => null },
    async () => {
      assert.equal(await channelHealthRepository.getHealth('ghost'), null);
    }
  );

  let captured = null;
  await withPrismaHealth(
    {
      'channelHealth.upsert': async (args) => { captured = args; return { channelId: 'c1' }; },
    },
    async () => {
      await channelHealthRepository.upsertHealth('c1', {
        activeSource: 'backup',
        consecutiveFails: 2,
        lastSwitchAt: new Date('2026-01-01T00:00:00Z'),
      });
      assert.equal(captured.where.channelId, 'c1');
      assert.equal(captured.update.activeSource, 'backup');
      assert.equal(captured.create.channelId, 'c1');
      assert.equal(captured.create.activeSource, 'backup');
      assert.ok(captured.create.lastSwitchAt instanceof Date);
    }
  );
});

test('repo: resetHealth P2025 é não-erro; removeStale contrato notIn', async () => {
  await withPrismaHealth(
    { 'channelHealth.delete': async () => { const e = new Error('not found'); e.code = 'P2025'; throw e; } },
    async () => {
      assert.equal(await channelHealthRepository.resetHealth('ghost'), null);
    }
  );

  let captured = null;
  await withPrismaHealth(
    {
      'channelHealth.deleteMany': async (args) => { captured = args; return { count: 2 }; },
    },
    async () => {
      assert.equal(await channelHealthRepository.removeStale([]), 0);
      assert.equal(captured, null);
      const n = await channelHealthRepository.removeStale(['a', 'b']);
      assert.equal(n, 2);
      assert.deepEqual(captured.where.channelId.notIn, ['a', 'b']);
    }
  );
});