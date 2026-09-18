'use strict';

/**
 * Lote 2 — Ações administrativas em lote + exportações CSV (adminController):
 *  - bulkChannelState: 1 caminho = setChannelState (applyChannelState);
 *    itens independentes; canal inexistente vira item-falha, nunca 500;
 *  - bulkUserActions: proteções NESCESSÁRIAS preservadas por item
 *    (anti-self-lockout, último admin ativo e confirm:true para delete);
 *  - exportAnalyticsCSV / exportAuditLogsCSV: 422 em parâmetros ruins e
 *    streaming CSV correto (cabeçalho, linhas, cursor na 2ª página).
 *
 * O ChannelHealthService é substituído por um fake antes do require do
 * controlador (auto-start de probes abriria dezenas de sockets em teste).
 */

const { test } = require('node:test');
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
const config = require('../src/config/app');
const adminController = require('../src/controllers/adminController');
const M3UService = require('../src/services/m3uService');
const ChannelStateService = require('../src/services/channelStateService');
const { schemas } = require('../src/middlewares/validate');

const ADMIN = { id: 'adm-1', name: 'Root', email: 'root@example.com', role: 'admin', status: 'active' };
const TARGET = { id: 'usr-9', name: 'Alvo', email: 'alvo@example.com', role: 'user', status: 'active' };
const ROLE_ADMIN = { id: 'role-admin', code: 'admin' };
const ROLE_USER = { id: 'role-user', code: 'user' };

const m3uService = M3UService.getShared();
const channelStateService = ChannelStateService.getShared();

function spyRes() {
  const res = { statusCode: null, jsonBody: null, sent: false };
  res.status = function (code) { this.statusCode = code; return this; };
  res.json = function (body) { this.jsonBody = body; this.sent = true; return this; };
  return res;
}

function spyStreamRes() {
  const chunks = [];
  const res = { chunks, headers: {}, headersSent: false, ended: false };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.write = (s) => { res.headersSent = true; chunks.push(String(s)); return true; };
  res.end = () => { res.headersSent = true; res.ended = true; };
  return res;
}

function makeNext() {
  const next = (err) => { if (err) throw err; return undefined; };
  return next;
}

function withPrismaMocks(mocks, fn) {
  const saved = {
    'user.findUnique': prisma.user.findUnique,
    'user.update': prisma.user.update,
    'user.delete': prisma.user.delete,
    'user.count': prisma.user.count,
    'role.findUnique': prisma.role.findUnique,
    'auditLog.create': prisma.auditLog.create,
    'playbackSession.findMany': prisma.playbackSession.findMany,
    'auditLog.findMany': prisma.auditLog.findMany,
  };
  const setPath = (path, value) => {
    const parts = path.split('.');
    let obj = prisma;
    for (let i = 0; i < parts.length - 1; i++) obj = obj[parts[i]];
    obj[parts[parts.length - 1]] = value;
  };
  for (const [path, mock] of Object.entries(mocks || {})) setPath(path, mock);
  setPath('auditLog.create', async () => ({}));

  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [path, orig] of Object.entries(saved)) setPath(path, orig);
    });
}

const originalGetChannelById = m3uService.getChannelById;
function withChannels(mapIdToChannel, fn) {
  m3uService.getChannelById = (id) => mapIdToChannel(id);
  return Promise.resolve()
    .then(fn)
    .finally(() => { m3uService.getChannelById = originalGetChannelById; });
}

const originalPersistState = config.channelState.persistEnabled;
function withNoStatePersistence(fn) {
  config.channelState.persistEnabled = false;
  return Promise.resolve()
    .then(fn)
    .finally(() => { config.channelState.persistEnabled = originalPersistState; });
}

// ── Bulk de estados de canais ────────────────────────────────

test('bulkChannelState: aplica estados de 2 canais (memória + objeto) e conta applied=2', async () => {
  const chA = { id: 'cA', name: 'Canal A', url: 'http://a/1.m3u8' };
  const chB = { id: 'cB', name: 'Canal B', url: 'http://b/1.m3u8' };
  await withNoStatePersistence(async () => {
    await withPrismaMocks({}, async () => {
      await withChannels((id) => (id === 'cA' ? chA : id === 'cB' ? chB : null), async () => {
        const res = spyRes();
        await adminController.bulkChannelState(
          {
            body: { items: [
              { channelId: 'cA', state: 'blocked', reason: 'veiculação' },
              { channelId: 'cB', state: 'maintenance' },
            ] },
            user: ADMIN,
          },
          res,
          makeNext()
        );

        assert.equal(res.statusCode, 200);
        assert.equal(res.jsonBody.data.applied, 2);
        assert.equal(res.jsonBody.data.failed, 0);
        assert.equal(res.jsonBody.data.results[0].success, true);
        assert.equal(res.jsonBody.data.results[0].state, 'blocked');
        assert.equal(res.jsonBody.data.results[0].reason, 'veiculação');
        assert.equal(chA.state, 'blocked');
        assert.equal(chB.state, 'maintenance');
        assert.equal(channelStateService.peek('cA'), 'blocked');
        assert.equal(channelStateService.peek('cB'), 'maintenance');
      });
    });
  });
});

test('bulkChannelState: canal inexistente vira item-falha e NÃO derruba o lote', async () => {
  const chA = { id: 'cA', name: 'Canal A', url: 'http://a/1.m3u8' };
  await withNoStatePersistence(async () => {
    await withPrismaMocks({}, async () => {
      await withChannels((id) => (id === 'cA' ? chA : null), async () => {
        const res = spyRes();
        await adminController.bulkChannelState(
          {
            body: { items: [
              { channelId: 'ghost', state: 'blocked' },
              { channelId: 'cA', state: 'live' },
              { channelId: 'ghost2', state: 'blocked' },
            ] },
            user: ADMIN,
          },
          res,
          makeNext()
        );

        assert.equal(res.statusCode, 200);
        assert.equal(res.jsonBody.data.applied, 1);
        assert.equal(res.jsonBody.data.failed, 2);
        assert.equal(res.jsonBody.data.results[0].success, false);
        assert.ok(String(res.jsonBody.data.results[0].error).includes('não encontrado'));
        assert.equal(res.jsonBody.data.results[1].success, true);
        assert.equal(res.jsonBody.data.results[2].success, false);
        assert.equal(channelStateService.peek('cA'), 'live');
      });
    });
  });
});

// ── Bulk de usuários ─────────────────────────────────────────

test('bulkUserActions: block ok + self-block recusado por item (anti-self-lockout preservado)', async () => {
  await withPrismaMocks(
    {
      'user.findUnique': async ({ where }) => {
        if (where.id === 'usr-9') return { ...TARGET };
        if (where.id === 'adm-1') return { ...ADMIN };
        return null;
      },
      'user.update': async ({ where, data }) => {
        assert.equal(where.id, 'usr-9');
        assert.equal(data.accountRestricted, true);
        assert.equal(data.status, 'inactive');
        return { ...TARGET, status: 'inactive', accountRestricted: true };
      },
    },
    async () => {
      const res = spyRes();
      await adminController.bulkUserActions(
        {
          body: { items: [
            { userId: 'usr-9', action: 'block', reason: 'spam' },
            { userId: 'adm-1', action: 'block' },
          ] },
          user: ADMIN,
        },
        res,
        makeNext()
      );

      assert.equal(res.statusCode, 200);
      assert.equal(res.jsonBody.data.applied, 1);
      assert.equal(res.jsonBody.data.failed, 1);
      assert.equal(res.jsonBody.data.results[1].success, false);
      assert.ok(String(res.jsonBody.data.results[1].error).includes('própria conta'));
    }
  );
});

test('bulkUserActions: delete sem confirm:true por item NÃO apaga', async () => {
  let deleted = false;
  await withPrismaMocks(
    {
      'user.findUnique': async () => ({ ...TARGET, role: 'user', status: 'active' }),
      'user.delete': async () => { deleted = true; return { id: 'usr-9' }; },
    },
    async () => {
      const res = spyRes();
      await adminController.bulkUserActions(
        { body: { items: [{ userId: 'usr-9', action: 'delete' }] }, user: ADMIN },
        res,
        makeNext()
      );
      assert.equal(res.jsonBody.data.applied, 0);
      assert.equal(res.jsonBody.data.results[0].success, false);
      assert.equal(deleted, false);
    }
  );
});

test('bulkUserActions: último admin ativo é protegido no bulk (demote/delete sem confirm → guarda vence)', async () => {
  const lastAdmin = { id: 'adm-9', role: 'admin', status: 'active', email: 'adm9@ex.com' };
  await withPrismaMocks(
    {
      'user.findUnique': async () => ({ ...lastAdmin }),
      'user.count': async () => 1,
    },
    async () => {
      const res = spyRes();
      await adminController.bulkUserActions(
        { body: { items: [{ userId: 'adm-9', action: 'demote' }] }, user: ADMIN },
        res,
        makeNext()
      );
      assert.equal(res.jsonBody.data.applied, 0);
      assert.equal(res.jsonBody.data.results[0].success, false);
      assert.ok(String(res.jsonBody.data.results[0].error).includes('último admin'));

      // Mesmo com confirm:true, delete do último admin é recusado.
      const res2 = spyRes();
      await adminController.bulkUserActions(
        { body: { items: [{ userId: 'adm-9', action: 'delete', confirm: true }] }, user: ADMIN },
        res2,
        makeNext()
      );
      assert.equal(res2.jsonBody.data.results[0].success, false);
      assert.ok(String(res2.jsonBody.data.results[0].error).includes('último admin'));
    }
  );
});

test('bulkUserActions: demote ok (role resolvida) + itens independentes', async () => {
  await withPrismaMocks(
    {
      'user.findUnique': async ({ where }) => {
        if (where.id === 'usr-9') return { ...TARGET };
        if (where.id === 'usr-g') return null;
        return null;
      },
      'role.findUnique': async () => ROLE_USER,
      'user.update': async (args) => {
        assert.equal(args.data.role, 'user');
        return { ...TARGET, role: 'user' };
      },
    },
    async () => {
      const res = spyRes();
      await adminController.bulkUserActions(
        { body: { items: [
          { userId: 'usr-9', action: 'demote' },
          { userId: 'usr-g', action: 'block' },
        ] }, user: ADMIN },
        res,
        makeNext()
      );
      assert.equal(res.jsonBody.data.applied, 1);
      assert.equal(res.jsonBody.data.failed, 1);
      assert.equal(res.jsonBody.data.results[1].success, false);
      assert.ok(String(res.jsonBody.data.results[1].error).includes('não encontrado'));
    }
  );
});

test('bulkUserActions: no-op do schema — itens acima de 50 ou sem itens são rejeitados (422)', () => {
  const empty = schemas.adminBulkUsers.validate({ items: [] });
  assert.ok(empty.error);
  assert.ok(String(empty.error.message).includes('ao menos'));

  const fiftyOne = schemas.adminBulkUsers.validate({
    items: Array.from({ length: 51 }, (_, i) => ({ userId: `u${i}`, action: 'block' })),
  });
  assert.ok(fiftyOne.error);
  assert.ok(String(fiftyOne.error.message).includes('50'));
});

// ── Exportações CSV ──────────────────────────────────────────

test('exportAnalyticsCSV: período inválido → 422 sem tocar o banco', async () => {
  let touched = false;
  await withPrismaMocks(
    { 'playbackSession.findMany': async () => { touched = true; return []; } },
    async () => {
      const res = spyRes();
      await adminController.exportAnalyticsCSV({ query: { period: 'mes' }, user: ADMIN }, res, makeNext());
      assert.equal(res.statusCode, 422);
      assert.equal(touched, false);
    }
  );
});

test('exportAnalyticsCSV: streaming correto (título + por canal + diário) com cursor na 2ª página', async () => {
  let calls = 0;
  const sessions = [
    { id: 's1', userId: 'u1', channelId: 'cA', channelName: 'Canal A', channelCategory: 'Filmes', status: 'completed', startedAt: new Date('2026-09-17T10:00:00Z'), watchDurationMs: BigInt(60000) },
    { id: 's2', userId: 'u2', channelId: 'cA', channelName: 'Canal A', channelCategory: 'Filmes', status: 'active', startedAt: new Date('2026-09-17T11:00:00Z'), watchDurationMs: BigInt(120000) },
  ];
  const capturedWhere = [];
  await withPrismaMocks(
    {
      'playbackSession.findMany': async (args) => {
        calls += 1;
        capturedWhere.push(args.where);
        return calls === 1 ? sessions : [];
      },
    },
    async () => {
      const res = spyStreamRes();
      await adminController.exportAnalyticsCSV(
        { query: { period: 'today' }, user: ADMIN },
        res,
        makeNext()
      );
      assert.equal(res.headers['Content-Type'], 'text/csv; charset=utf-8');
      assert.equal(res.headers['Content-Disposition'], 'attachment; filename="analytics.csv"');
      assert.equal(res.ended, true);

      const body = res.chunks.join('');

      // O período "today" é derivado da data de execução (resolveRange usa o
      // relógio real) — o cabeçalho deve refletir o dia UTC corrente, nunca
      // um valor fixo (este teste anteriormente hardcodava a data de escrita).
      const periodStart = new Date();
      periodStart.setUTCHours(0, 0, 0, 0);
      const today = periodStart.toISOString().slice(0, 10);
      assert.match(body, new RegExp(`^relatorio_analytics,periodo_${today}_${today}\\r\\n`));
      assert.match(body, /canal_id,canal,categoria,sessoes,espectadores_unicos,tempo_total_ms,tempo_total,tempo_medio_ms\r\n/);
      assert.match(body, /cA,Canal A,Filmes,2,2,180000,3min,90000\r\n/);
      assert.match(body, /^data,sessoes,espectadores_unicos,tempo_total_ms,tempo_total\r\n/m);
      assert.match(body, /2026-09-17,2,2,180000,3min\r\n/);

      // Cursor: a segunda página usa id > último visto (nunca offset).
      assert.equal(calls, 2);
      assert.equal(capturedWhere[0].startedAt.gte instanceof Date, true);
      assert.equal(capturedWhere[1].id.gt, 's2');
    }
  );
});

test('exportAuditLogsCSV: parâmetros ruins → 422 (ausentes, invertidos, intervalo longo)', async () => {
  const bad = async (query) => {
    const res = spyRes();
    await adminController.exportAuditLogsCSV({ query, user: ADMIN }, res, makeNext());
    assert.equal(res.statusCode, 422);
  };
  await bad({});
  await bad({ from: '2026-09-01' });
  await bad({ from: '2026-09-17', to: '2026-09-01' });
  await bad({ from: 'bacon', to: '2026-09-17' });
  await bad({ from: '2025-01-01', to: '2026-09-17' });
});

test('exportAuditLogsCSV: streaming com cursor composto (createdAt,id) e células anti-fórmula', async () => {
  const logs = [
    { id: 'log1', createdAt: new Date('2026-09-01T00:00:00Z'), action: 'admin.channel.state', email: 'a@b.c', userId: 'u1', ip: '1.2.3.4', requestId: null, channelId: 'c1', userAgent: '=evil()', meta: { prevState: 'live', state: 'blocked' } },
    { id: 'log2', createdAt: new Date('2026-09-01T00:00:01Z'), action: 'admin.user.view', email: null, userId: null, ip: '5.6.7.8', requestId: 'req-1', channelId: null, userAgent: 'Mozilla/5.0', meta: null },
  ];
  let calls = 0;
  const capturedWhere = [];
  await withPrismaMocks(
    {
      'auditLog.findMany': async (args) => {
        calls += 1;
        capturedWhere.push(args.where);
        return calls === 1 ? logs : [];
      },
    },
    async () => {
      const res = spyStreamRes();
      await adminController.exportAuditLogsCSV(
        { query: { from: '2026-09-01', to: '2026-09-17' }, user: ADMIN },
        res,
        makeNext()
      );
      assert.equal(res.headers['Content-Disposition'], 'attachment; filename="audit-logs.csv"');
      assert.equal(res.ended, true);

      const body = res.chunks.join('');
      assert.match(body, /^created_at,action,email,user_id,ip,request_id,channel_id,user_agent,meta\r\n/);
      assert.match(
        body,
        /2026-09-01T00:00:00\.000Z,admin\.channel\.state,a@b\.c,u1,1\.2\.3\.4,,c1,'=evil\(\),"\{""prevState"":""live"",""state"":""blocked""\}"\r\n/
      );

      assert.equal(calls, 2);
      assert.deepEqual(capturedWhere[0].createdAt.gte instanceof Date, true);
      assert.deepEqual(capturedWhere[1].OR[0], { createdAt: { gt: logs[1].createdAt } });
      assert.deepEqual(capturedWhere[1].OR[1], { createdAt: logs[1].createdAt, id: { gt: 'log2' } });
    }
  );
});