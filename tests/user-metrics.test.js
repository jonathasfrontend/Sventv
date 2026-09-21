'use strict';

/**
 * Métricas de usuários (painel admin) — userMetricsService + controller.
 *
 * Cobra:
 *  - periodos: mapeamento week/month/quarter/semester (janelas rolantes) e
 *    422 para valores inválidos no controller;
 *  - crescimento com previous=0 → 'novo' (nunca Infinity/NaN);
 *  - serie diaria: date_trunc + preenchimento de dias vazios com 0;
 *  - status/engajamento/seguranca/termos: agregados corretos e sem PII;
 *  - seguranca normalizada para os 5 eventos (ausentes com count 0);
 *  - controller: padrao de resposta {success, message, data}, erro → next.
 *
 * O ChannelHealthService e trocado por um fake antes do require do controller
 * (auto-start de probes abriria sockets em teste) — mesmo padrao do
 * admin-bulk-controller.test.js.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

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
  async ensureLoaded() { return 0; }
}
FakeHealthService._shared = null;
FakeHealthService.getShared = () => {
  if (!FakeHealthService._shared) FakeHealthService._shared = new FakeHealthService();
  return FakeHealthService._shared;
};
require.cache[HEALTH_PATH] = {
  id: HEALTH_PATH,
  filename: HEALTH_PATH,
  loaded: true,
  exports: FakeHealthService,
};

const prisma = require('../src/prisma/client');
const userMetricsService = require('../src/services/userMetricsService');
const adminController = require('../src/controllers/adminController');

// ── Helpers ─────────────────────────────────────────────────——

/** Substitui paths do prisma (ex.: 'user.count') e restaura ao final. */
function withPrisma(overrides, fn) {
  const saved = {};
  const setPath = (path, value) => {
    const parts = path.split('.');
    let obj = prisma;
    for (let i = 0; i < parts.length - 1; i++) obj = obj[parts[i]];
    saved[path] = obj[parts[parts.length - 1]];
    obj[parts[parts.length - 1]] = value;
  };
  for (const [path, value] of Object.entries(overrides)) setPath(path, value);

  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [path, orig] of Object.entries(saved)) {
        const parts = path.split('.');
        let obj = prisma;
        for (let i = 0; i < parts.length - 1; i++) obj = obj[parts[i]];
        obj[parts[parts.length - 1]] = orig;
      }
    });
}

function spyRes() {
  const res = { statusCode: null, jsonBody: null, sent: false };
  res.status = function (code) { this.statusCode = code; return this; };
  res.json = function (body) { this.jsonBody = body; this.sent = true; return this; };
  return res;
}

function makeNext() {
  const next = (err) => { if (err) throw err; return undefined; };
  return next;
}

async function callGetUserMetrics(period) {
  const res = spyRes();
  const req = { query: period === undefined ? {} : { period } };
  await adminController.getUserMetrics(req, res, makeNext());
  return res;
}

// Para isolar o controller do serviço real:
const originalGetOverview = userMetricsService.getOverview;
function withOverviewMock(fn, impl) {
  userMetricsService.getOverview = impl || (async () => ({ period: 'week', dummy: true }));
  return Promise.resolve()
    .then(fn)
    .finally(() => { userMetricsService.getOverview = originalGetOverview; });
}

// ── Períodos ────────────────────────────────────────────────────

test('userMetrics: resolveUserRange mapeia week/month/quarter/semester (janelas rolantes)', () => {
  const t0 = Date.now();
  const r = userMetricsService.resolveUserRange('week');
  assert.ok(r);
  assert.equal(r.days, 7);
  assert.ok(Math.abs((Date.now() - 7 * 24 * 60 * 60 * 1000) - r.start.getTime()) < 5000);
  assert.ok(r.end.getTime() > t0, 'end deve incluir "agora"');

  assert.equal(userMetricsService.resolveUserRange('month').days, 30);
  assert.equal(userMetricsService.resolveUserRange('quarter').days, 90);
  assert.equal(userMetricsService.resolveUserRange('semester').days, 180);
});

test('userMetrics: resolveUserRange rejeita inválidos (inclusive aliases de analytics)', () => {
  for (const bad of ['year', '7d', 'today', 'foo', '', undefined, 'WEEKLY']) {
    assert.equal(userMetricsService.resolveUserRange(bad), null, `deve rejeitar ${String(bad)}`);
  }
  assert.equal(userMetricsService.resolveUserRange('Semester').days, 180, 'aceita case-insensitive');
});

// ── Crescimento ─────────────────────────────────────────────────

test('userMetrics: getUserGrowth calcula pct arredondado e trata previous=0 como "novo"', async () => {
  const range = { start: new Date('2026-09-10T00:00:00Z'), end: new Date('2026-09-17T00:01:00Z') };
  const calls = [];
  await withPrisma({
    'user.count': async (args) => {
      calls.push(args);
      return calls.length === 1 ? 3 : 1;
    },
  }, async () => {
    const growth = await userMetricsService.getUserGrowth(range);
    assert.equal(growth.current, 3);
    assert.equal(growth.previous, 1);
    assert.equal(growth.growthPct, 200);
  });

  assert.equal(calls.length, 2);
  assert.ok(calls[0].where.createdAt.gte.getTime() === range.start.getTime());
  assert.ok(calls[1].where.createdAt.lt.getTime() === range.start.getTime());
});

test('userMetrics: getUserGrowth com previous=0 devolve growthPct "novo" (nunca Infinity/NaN)', async () => {
  const range = { start: new Date('2026-09-10T00:00:00Z'), end: new Date('2026-09-17T00:01:00Z') };
  await withPrisma({
    'user.count': async () => 0,
  }, async () => {
    const growth = await userMetricsService.getUserGrowth(range);
    assert.equal(growth.current, 0);
    assert.equal(growth.previous, 0);
    assert.equal(growth.growthPct, 'novo');
  });
});

// ── Série diária ────────────────────────────────────────────────

test('userMetrics: getUserGrowthSeries preenche dias vazios com 0, ordena e formata YYYY-MM-DD', async () => {
  const range = {
    start: new Date('2026-09-10T00:00:00Z'),
    end: new Date('2026-09-14T23:59:59Z'),
  };
  await withPrisma({
    '$queryRaw': async () => [
      { day: new Date('2026-09-11T00:00:00Z'), count: 3 },
      { day: new Date('2026-09-13T00:00:00Z'), count: 1 },
    ],
  }, async () => {
    const series = await userMetricsService.getUserGrowthSeries(range);
    assert.deepEqual(series, [
      { date: '2026-09-10', count: 0 },
      { date: '2026-09-11', count: 3 },
      { date: '2026-09-12', count: 0 },
      { date: '2026-09-13', count: 1 },
      { date: '2026-09-14', count: 0 },
    ]);
  });
});

test('userMetrics: getUserGrowthSeries tolera count como string (BigInt do PG via ::int segue Number)', async () => {
  const range = {
    start: new Date('2026-09-10T00:00:00Z'),
    end: new Date('2026-09-10T23:59:59Z'),
  };
  await withPrisma({
    '$queryRaw': async () => [{ day: new Date('2026-09-10T00:00:00Z'), count: '7' }],
  }, async () => {
    const series = await userMetricsService.getUserGrowthSeries(range);
    assert.deepEqual(series, [{ date: '2026-09-10', count: 7 }]);
  });
});

// ── Status ──────────────────────────────────────────────────────

test('userMetrics: getStatusBreakdown retorna snapshot agregado', async () => {
  const counts = [100, 95, 2, 3, 97];
  const whereCalls = [];
  let call = 0;
  await withPrisma({
    'user.count': async (args) => {
      whereCalls.push(args && args.where ? args.where : null);
      return counts[call++];
    },
  }, async () => {
    const totals = await userMetricsService.getStatusBreakdown();
    assert.deepEqual(totals, { all: 100, active: 95, blocked: 2, admins: 3, users: 97 });
  });
  assert.deepEqual(whereCalls[2], { accountRestricted: true }, 'bloqueados usa accountRestricted (status nunca é "blocked")');
});

// ── Engajamento ─────────────────────────────────────────────────

test('userMetrics: getEngagementSnapshot usa DISTINCT de lastPlayedAt e taxa sobre criados no período', async () => {
  const range = { start: new Date('2026-09-10T00:00:00Z'), end: new Date('2026-09-17T00:01:00Z') };
  let watchCalled = null;
  let userCount = 40;
  await withPrisma({
    'watchHistory.findMany': async (args) => {
      watchCalled = args;
      return [{ userId: 'a' }, { userId: 'b' }, { userId: 'c' }, { userId: 'd' }];
    },
    'user.count': async () => userCount,
  }, async () => {
    const eng = await userMetricsService.getEngagementSnapshot(range);
    assert.equal(eng.activeInPeriod, 4);
    assert.equal(eng.createdInPeriod, 40);
    assert.equal(eng.activationRate, 10);
  });

  // where usa lastPlayedAt na janela + distinct no userId
  assert.ok(watchCalled.where.lastPlayedAt.gte.getTime() === range.start.getTime());
  assert.deepEqual(watchCalled.distinct, ['userId']);
});

test('userMetrics: getEngagementSnapshot com 0 criados no período → activationRate 0', async () => {
  const range = { start: new Date('2026-09-10T00:00:00Z'), end: new Date('2026-09-17T00:01:00Z') };
  await withPrisma({
    'watchHistory.findMany': async () => [{ userId: 'a' }],
    'user.count': async () => 0,
  }, async () => {
    const eng = await userMetricsService.getEngagementSnapshot(range);
    assert.equal(eng.activeInPeriod, 1);
    assert.equal(eng.createdInPeriod, 0);
    assert.equal(eng.activationRate, 0);
  });
});

// ── Segurança ───────────────────────────────────────────────────

test('userMetrics: getSecurityEventCounts normaliza os 5 eventos (ausentes com 0)', async () => {
  const range = { start: new Date('2026-09-10T00:00:00Z'), end: new Date('2026-09-17T00:01:00Z') };
  let where = null;
  await withPrisma({
    'auditLog.groupBy': async (args) => {
      where = args.where;
      return [
        { action: 'auth.account_locked', _count: { _all: 2 } },
        { action: 'admin.user_block', _count: { _all: 5 } },
      ];
    },
  }, async () => {
    const security = await userMetricsService.getSecurityEventCounts(range);
    assert.deepEqual(security, [
      { action: 'auth.account_locked', count: 2 },
      { action: 'auth.password_reset_attempts_exceeded', count: 0 },
      { action: 'admin.user_block', count: 5 },
      { action: 'admin.user_unblock', count: 0 },
      { action: 'admin.change_user_role', count: 0 },
    ]);
  });

  assert.deepEqual(where.action.in, userMetricsService.SECURITY_EVENTS);
  assert.ok(where.createdAt.gte.getTime() === range.start.getTime());
});

// ── Termos ──────────────────────────────────────────────────────

test('userMetrics: getTermsAcceptanceBreakdown agrupa por versão e totaliza com/sem', async () => {
  await withPrisma({
    'user.groupBy': async () => [
      { termsVersion: 'v2', _count: { termsVersion: 5 } },
      { termsVersion: 'v1', _count: { termsVersion: 3 } },
    ],
    'user.count': async (args) => {
      const w = args.where.termsVersion;
      return w && w.not === null ? 8 : 3;
    },
  }, async () => {
    const terms = await userMetricsService.getTermsAcceptanceBreakdown();
    assert.equal(terms.withTerms, 8);
    assert.equal(terms.withoutTerms, 3);
    assert.deepEqual(terms.breakdown, [
      { version: 'v2', count: 5 },
      { version: 'v1', count: 3 },
    ]);
  });
});

// ── Overview / controller ───────────────────────────────────────

test('userMetrics: getOverview devolve null para período inválido', async () => {
  assert.equal(await userMetricsService.getOverview('year'), null);
});

test('userMetrics (controller): 200 com shape {success, message, data} para período válido', async () => {
  await withOverviewMock(async () => {
    const res = await callGetUserMetrics('quarter');
    assert.equal(res.statusCode, 200);
    assert.equal(res.jsonBody.success, true);
    assert.equal(res.jsonBody.message, 'Métricas de usuários carregadas.');
    assert.equal(res.jsonBody.data.period, 'quarter');
    assert.equal(res.jsonBody.data.dummy, true);
  }, async () => ({ period: 'quarter', dummy: true }));
});

test('userMetrics (controller): sem period → padrão week', async () => {
  const seen = [];
  await withOverviewMock(async () => {
    const res = await callGetUserMetrics(undefined);
    assert.equal(res.statusCode, 200);
    assert.ok(seen[0] === 'week', 'padrão deve ser week');
  }, async (period) => { seen.push(period); return { period: 'week' }; });
});

test('userMetrics (controller): período inválido → 422 com mensagem', async () => {
  for (const bad of ['year', '7d', 'today', 'foo']) {
    const res = await callGetUserMetrics(bad);
    assert.equal(res.statusCode, 422, `deve dar 422 para ${bad}`);
    assert.equal(res.jsonBody.success, false);
    assert.match(res.jsonBody.message, /week, month, quarter ou semester/);
  }
});

test('userMetrics (controller): erro no serviço → next(error)', async () => {
  await withOverviewMock(async () => {
    const res = spyRes();
    const next = (err) => { assert.equal(err && err.message, 'db boom'); };
    const req = { query: { period: 'week' } };
    await adminController.getUserMetrics(req, res, next);
  }, async () => { throw new Error('db boom'); });
});