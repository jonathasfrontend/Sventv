'use strict';

/**
 * Retenção de dados operacionais (retentionService.runRetention):
 *  - request_usage e audit_logs expirados são apagados com cortes corretos;
 *  - 0 desativa a limpeza daquele tipo (sem remover variáveis);
 *  - métricas de contagem (retentionRuns / retentionRequestUsageDeleted /
 *    retentionAuditLogsDeleted);
 *  - falha de banco PROPAGA (fail-silent esconderia o problema do cron).
 *
 * O cliente Prisma é Proxy-based → substituição manual com restore em finally
 * (padrão dos demais repositórios).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const config = require('../src/config/app');
const prisma = require('../src/prisma/client');
const { runRetention } = require('../src/services/retentionService');
const { snapshot: metricsSnapshot } = require('../src/utils/metrics');

const withPrismaRetention = (mocks, fn) => {
  const saved = {
    'requestUsage.deleteMany': prisma.requestUsage.deleteMany,
    'auditLog.deleteMany': prisma.auditLog.deleteMany,
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
};

const withRetentionConfig = (overrides, fn) => {
  const saved = {
    requestUsageDays: config.retention.requestUsageDays,
    auditLogDays: config.retention.auditLogDays,
  };
  Object.assign(config.retention, overrides);
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      config.retention.requestUsageDays = saved.requestUsageDays;
      config.retention.auditLogDays = saved.auditLogDays;
    });
};

test('runRetention usa cortes corretos e agrega contagens + métricas', async () => {
  let usageArgs = null;
  let auditArgs = null;
  const t0 = Date.now();

  await withRetentionConfig({ requestUsageDays: 30, auditLogDays: 90 }, async () => {
    await withPrismaRetention(
      {
        'requestUsage.deleteMany': async (args) => { usageArgs = args; return { count: 7 }; },
        'auditLog.deleteMany': async (args) => { auditArgs = args; return { count: 3 }; },
      },
      async () => {
        const r0 = metricsSnapshot().counters;
        const out = await runRetention();
        assert.equal(out.requestUsageDeleted, 7);
        assert.equal(out.auditLogsDeleted, 3);

        const snap = metricsSnapshot().counters;
        assert.equal(snap.retentionRuns, r0.retentionRuns + 1);
        assert.equal(snap.retentionRequestUsageDeleted, r0.retentionRequestUsageDeleted + 7);
        assert.equal(snap.retentionAuditLogsDeleted, r0.retentionAuditLogsDeleted + 3);
      }
    );
  });

  const DAY = 86400000;
  assert.ok(usageArgs, 'deletou request_usage');
  assert.ok(usageArgs.where.bucketStart.lt instanceof Date);
  const usageCutoff = usageArgs.where.bucketStart.lt.getTime();
  assert.ok(usageCutoff <= t0 - 30 * DAY + 1000 && usageCutoff >= t0 - 30 * DAY - 1000,
    `corte request_usage ~30d (${new Date(usageCutoff).toISOString()})`);

  assert.ok(auditArgs.where.createdAt.lt instanceof Date);
  const auditCutoff = auditArgs.where.createdAt.lt.getTime();
  assert.ok(auditCutoff <= t0 - 90 * DAY + 1000 && auditCutoff >= t0 - 90 * DAY - 1000,
    `corte audit_logs ~90d (${new Date(auditCutoff).toISOString()})`);
});

test('runRetention: flag 0 desativa a limpeza daquele tipo (sem chamar o banco)', async () => {
  await withRetentionConfig({ requestUsageDays: 0, auditLogDays: 0 }, async () => {
    const r0 = metricsSnapshot().counters;
    await withPrismaRetention(
      {
        'requestUsage.deleteMany': async () => { throw new Error('nao deveria chamar'); },
        'auditLog.deleteMany': async () => { throw new Error('nao deveria chamar'); },
      },
      async () => {
        const out = await runRetention();
        assert.deepEqual(out, { requestUsageDeleted: 0, auditLogsDeleted: 0 });
      }
    );
    assert.equal(metricsSnapshot().counters.retentionRuns, r0.retentionRuns + 1);
  });
});

test('runRetention: corte parcial (apenas audit_logs) não afeta o outro', async () => {
  let usageCalled = false;
  await withRetentionConfig({ requestUsageDays: 0, auditLogDays: 90 }, async () => {
    await withPrismaRetention(
      {
        'requestUsage.deleteMany': async () => { usageCalled = true; return { count: 99 }; },
        'auditLog.deleteMany': async () => ({ count: 0 }),
      },
      async () => {
        const out = await runRetention();
        assert.equal(out.requestUsageDeleted, 0);
        assert.equal(out.auditLogsDeleted, 0);
        assert.equal(usageCalled, false);
      }
    );
  });
});

test('runRetention: falha de banco PROPAGA (nunca mascara o problema do cron)', async () => {
  await withPrismaRetention(
    { 'requestUsage.deleteMany': async () => { throw new Error('pg timeout'); } },
    async () => {
      await assert.rejects(() => runRetention(), /pg timeout/);
    }
  );
});