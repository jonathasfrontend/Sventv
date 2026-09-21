'use strict';

/**
 * Alertas administrativos de eventos de usuário (PROMPT MASTER):
 *  - auth.user_registered                 (chave por usuário)
 *  - auth.account_locked                  (chave por usuário)
 *  - auth.password_reset_attempts_exceeded (chave por usuário)
 *  - admin.role_escalation                (chave entidade+timestamp)
 *  - admin.user_deleted                   (chave entidade+timestamp)
 *  - auth.register_rate_limited           (chave genérica + cooldown)
 *
 * Regras verificadas aqui:
 *  - fire-and-forget e nunca bloqueiam o fluxo principal (resposta sai);
 *  - eventKey isola o debounce (2 registros → 2 alertas; promoção repetida
 *    → 2 alertas; rate limit repetido → 1 alerta);
 *  - disparo APÓS a persistência (falha NUNCA gera alerta falso);
 *  - payload contém apenas ids/nomes/e-mails (nunca senha/hash/token);
 *  - 429 público genérico (IP só no canal privado do admin).
 *
 * O ChannelHealthService é substituído por um fake antes do require do
 * adminController (auto-start de probes abriria dezenas de sockets em teste).
 */

const { test, mock } = require('node:test');
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

const alertService = require('../src/services/alertService');
const config = require('../src/config/app');
const authService = require('../src/services/authService');
const User = require('../src/models/User');
const prisma = require('../src/prisma/client');
const adminController = require('../src/controllers/adminController');
const { passwordResetService, PasswordResetError, hashCode } = require('../src/services/passwordResetService');
const passwordResetCodeRepository = require('../src/repositories/passwordResetCodeRepository');
const emailService = require('../src/services/emailService');
const auditService = require('../src/services/auditService');
const bcrypt = require('bcryptjs');
const { setDatabaseConnected, isDatabaseConnected } = require('../src/utils/dbState');
const redisStore = require('../src/services/redisStore');

// ── Helpers ───────────────────────────────────────────────────

let webhooks = [];

/** Instala sinks de captura (sem SMTP/rede) e limpa o debounce. */
function withSinks(fn) {
  webhooks = [];
  alertService.resetCooldown();
  alertService._setSinks({
    sendEmail: async () => true,
    sendWebhook: async (text) => { webhooks.push(text); },
  });
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      alertService._setSinks(null);
      alertService.resetCooldown();
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

function flushMicro() {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Substitui métodos do Prisma (Proxy incompatível com mock.method). */
function withPrisma(mocks, fn) {
  const saved = {};
  const set = (path, value) => {
    const parts = path.split('.');
    let obj = prisma;
    for (let i = 0; i < parts.length - 1; i++) obj = obj[parts[i]];
    saved[path] = obj[parts[parts.length - 1]];
    obj[parts[parts.length - 1]] = value;
  };
  for (const [path, fnMock] of Object.entries(mocks)) set(path, fnMock);
  set('auditLog.create', async () => ({}));
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [path, orig] of Object.entries(saved)) set(path, orig);
    });
}

const ADMIN = { id: 'adm-1', name: 'Root', email: 'root@example.com', role: 'admin', status: 'active' };
const TARGET_USER = { id: 'usr-9', name: 'Alvo', email: 'alvo@example.com', role: 'user', status: 'active', accountRestricted: false };
const TARGET_USER2 = { id: 'usr-10', name: 'Alvo2', email: 'alvo2@example.com', role: 'user', status: 'active', accountRestricted: false };

// ── auth.user_registered ─────────────────────────────────────

test('register: alerta auth.user_registered por usuário — 2 contas → 2 alertas (cooldown não engole)', async () => {
  const savedDb = isDatabaseConnected();
  const makeUser = (id, name, email) => ({
    _id: id,
    id,
    name,
    email,
    avatar: '',
    role: 'user',
    status: 'active',
    sessionVersion: 0,
    createdAt: new Date('2026-09-19T10:00:00Z'),
    toJSON() { return { _id: id, id, name, email }; },
    generateSessionToken: () => `sess-${id}`,
  });
  const m1 = mock.method(User, 'findOne', async () => null);
  const created = [];
  let seq = 0;
  const m2 = mock.method(User, 'create', async (d) => {
    seq += 1;
    const fake = makeUser(`new-${seq}`, d.name, d.email);
    created.push(fake);
    return fake;
  });
  const m3 = mock.method(User, 'findByIdWithSensitive', async (id) => {
    const base = created.find((c) => c._id === id) || makeUser(id, 'Ana', `ana-${id}@x.com`);
    return { ...base, apiToken: 'tok-1' };
  });
  setDatabaseConnected(true);
  try {
    await withSinks(async () => {
      await authService.register({ name: 'Ana', email: 'ana@x.com', password: 'NovaSenha1!', confirmPassword: 'NovaSenha1!', acceptedTerms: true });
      await authService.register({ name: 'Bruna', email: 'bruna@x.com', password: 'NovaSenha1!', confirmPassword: 'NovaSenha1!', acceptedTerms: true });
    });
    assert.equal(webhooks.length, 2);
    assert.ok(webhooks[0].includes('auth.user_registered:new-1'));
    assert.ok(webhooks[1].includes('auth.user_registered:new-2'));
    assert.ok(webhooks[0].includes('ana@x.com'));
    assert.ok(webhooks[1].includes('bruna@x.com'));
    for (const w of webhooks) {
      assert.ok(!w.includes('NovaSenha1!'), 'payload NUNCA contém senha');
      assert.ok(!w.includes('sess-'), 'payload NUNCA contém token');
    }
  } finally {
    setDatabaseConnected(savedDb);
    m1.mock.restore();
    m2.mock.restore();
    m3.mock.restore();
  }
});

// ── auth.account_locked ──────────────────────────────────────

test('incLoginAttempts: bloqueio real (next >= max) dispara auth.account_locked', async () => {
  const savedMax = config.security.maxLoginAttempts;
  config.security.maxLoginAttempts = 3;
  const u = new User({
    _id: 'u-1',
    id: 'u-1',
    email: 'cliente@x.com',
    loginAttempts: 2,
    lockUntil: null,
    status: 'active',
    role: 'user',
    sessionVersion: 0,
  });
  // audit(auth.account_locked) é fire-and-forget (prisma.auditLog.create) —
  // stub manual (Proxy Prisma incompatível com mock.method) para nunca tocar
  // o banco real nos testes.
  const savedAuditCreate = prisma.auditLog.create;
  let auditArgs = null;
  prisma.auditLog.create = async (args) => { auditArgs = args && args.data ? args.data : args; return {}; };
  const m = mock.method(userRepositoryOf(), 'updateById', async (id, updates) => ({
    id,
    email: 'cliente@x.com',
    name: 'Cliente',
    avatar: '',
    status: 'active',
    role: 'user',
    roleId: null,
    loginAttempts: 3,
    lockUntil: updates.lockUntil,
    apiTokenVersion: 0,
    apiTokenActive: true,
    sessionVersion: 0,
    accountRestricted: false,
  }));
  try {
    await withSinks(async () => {
      await u.incLoginAttempts();
    });
    assert.equal(webhooks.length, 1);
    assert.ok(webhooks[0].includes('auth.account_locked:u-1'));
    assert.ok(webhooks[0].includes('cliente@x.com'));
    assert.ok(webhooks[0].includes(new Date(u.lockUntil).toISOString()));
    assert.equal(u.isLocked, true);
    // A trilha de auditoria também registra o bloqueio (métrica de segurança).
    assert.ok(auditArgs, 'audit de auth.account_locked deve ser gravado');
    assert.equal(auditArgs.action, 'auth.account_locked');
    assert.equal(auditArgs.userId, 'u-1');
    assert.equal(auditArgs.email, 'cliente@x.com');
    assert.ok(!auditArgs.meta || auditArgs.meta.lockUntil, 'meta deve conter lockUntil');
  } finally {
    config.security.maxLoginAttempts = savedMax;
    m.mock.restore();
    prisma.auditLog.create = savedAuditCreate;
  }
});

function userRepositoryOf() {
  return require('../src/repositories/userRepository').userRepository;
}

test('incLoginAttempts: falha no UPDATE não dispara alerta (só após persistência)', async () => {
  const u = new User({
    _id: 'u-2',
    id: 'u-2',
    email: 'falha@x.com',
    loginAttempts: 2,
    lockUntil: null,
    status: 'active',
    role: 'user',
    sessionVersion: 0,
  });
  const m = mock.method(userRepositoryOf(), 'updateById', async () => { throw new Error('db down'); });
  try {
    await withSinks(async () => {
      await assert.rejects(() => u.incLoginAttempts());
    });
    assert.equal(webhooks.length, 0);
  } finally {
    m.mock.restore();
  }
});

// ── auth.password_reset_attempts_exceeded ────────────────────

const fakeUser = { id: 'usr-1', email: 'fulano@example.com', name: 'Fulano', sessionVersion: 3 };

function mockReset(deps) {
  const m = {};
  m.userFind = mock.method(User, 'findByEmail', async () => deps.dbUser);
  for (const [k, v] of Object.entries(deps.repo || {})) {
    m[k] = mock.method(passwordResetCodeRepository, k, async (...a) => v(...a));
  }
  m.send = mock.method(emailService, 'sendPasswordResetCode', async () => ({ messageId: 'm1' }));
  m.audit = mock.method(auditService, 'audit', async () => {});
  m.hash = mock.method(bcrypt, 'hash', async () => 'HASHED_SENHA');
  return m;
}

function restoreReset(m) {
  m.userFind.mock.restore();
  for (const k of ['deleteUnusedForUser', 'create', 'findActiveForUser', 'incrementAttemptIfAllowed', 'invalidate', 'consumeAndSetPassword']) {
    if (passwordResetCodeRepository[k] && passwordResetCodeRepository[k].mock) {
      passwordResetCodeRepository[k].mock.restore();
    }
  }
  m.send.mock.restore();
  m.audit.mock.restore();
  m.hash.mock.restore();
}

const active = (over = {}) => ({
  id: 'code-1',
  userId: 'usr-1',
  codeHash: hashCode('123456'),
  expiresAt: new Date(Date.now() + 100000),
  attempts: 0,
  usedAt: null,
  ...over,
});

const req = { ip: '127.0.0.1', headers: {}, originalUrl: '/api/auth/reset-password' };

test('resetPassword: teto atingido por incremento dispara alerta de tentativas excedidas', async () => {
  const m = mockReset({
    dbUser: fakeUser,
    repo: {
      findActiveForUser: async () => active(),
      incrementAttemptIfAllowed: async () => null,
      invalidate: async () => ({ count: 1 }),
    },
  });
  try {
    await withSinks(async () => {
      await assert.rejects(
        () => passwordResetService.resetPassword({ email: 'fulano@example.com', code: '000000', newPassword: 'NovaSenha1!', req }),
        (err) => err instanceof PasswordResetError
      );
    });
    assert.equal(webhooks.length, 1);
    assert.ok(webhooks[0].includes('auth.password_reset_attempts_exceeded:usr-1'));
    assert.ok(!webhooks[0].includes('NovaSenha1!'));
  } finally {
    restoreReset(m);
  }
});

test('resetPassword: teto pré-existente no código dispara alerta de tentativas excedidas', async () => {
  const m = mockReset({
    dbUser: fakeUser,
    repo: {
      findActiveForUser: async () => active({ attempts: 5 }),
      invalidate: async () => ({ count: 1 }),
    },
  });
  try {
    await withSinks(async () => {
      await assert.rejects(
        () => passwordResetService.resetPassword({ email: 'fulano@example.com', code: '123456', newPassword: 'NovaSenha1!', req })
      );
    });
    assert.equal(webhooks.length, 1);
    assert.ok(webhooks[0].includes('auth.password_reset_attempts_exceeded:usr-1'));
  } finally {
    restoreReset(m);
  }
});

test('resetPassword: sucesso NÃO gera alerta de tentativas excedidas', async () => {
  const m = mockReset({
    dbUser: fakeUser,
    repo: {
      findActiveForUser: async () => active(),
      incrementAttemptIfAllowed: async () => ({ id: 'code-1', attempts: 1 }),
      consumeAndSetPassword: async () => ({ consumed: 1, user: { ...fakeUser, sessionVersion: 4 } }),
    },
  });
  try {
    await withSinks(async () => {
      const out = await passwordResetService.resetPassword({ email: 'fulano@example.com', code: '123456', newPassword: 'NovaSenha1!', req });
      assert.equal(out.ok, true);
    });
    assert.equal(webhooks.length, 0);
  } finally {
    restoreReset(m);
  }
});

// ── admin.role_escalation ────────────────────────────────────

test('changeUserRole: promoção para admin dispara alerta admin.role_escalation (com quem promoveu)', async () => {
  await withPrisma(
    {
      'user.findUnique': async () => ({ ...TARGET_USER }),
      'role.findUnique': async () => ({ id: 'r-admin', code: 'admin' }),
      'user.update': async () => ({ ...TARGET_USER, role: 'admin' }),
    },
    async () => {
      await withSinks(async () => {
        const res = spyRes();
        await adminController.changeUserRole(
          { params: { userId: 'usr-9' }, body: { role: 'admin' }, user: ADMIN },
          res,
          makeNext()
        );
        assert.equal(res.statusCode, 200);
        assert.equal(webhooks.length, 1);
        assert.ok(webhooks[0].includes('admin.role_escalation:usr-9:'));
        assert.ok(webhooks[0].includes('alvo@example.com'));
        assert.ok(webhooks[0].includes('root@example.com'));
      });
    }
  );
});

test('changeUserRole: promoções repetidas NUNCA são engolidas pelo debounce (2 alertas)', async () => {
  const clock = { current: 2000000000000 };
  const m = mock.method(Date, 'now', () => clock.current++);
  try {
    await withPrisma(
      {
        'user.findUnique': async () => ({ ...TARGET_USER }),
        'role.findUnique': async () => ({ id: 'r-admin', code: 'admin' }),
        'user.update': async () => ({ ...TARGET_USER, role: 'admin' }),
      },
      async () => {
        await withSinks(async () => {
          await adminController.changeUserRole({ params: { userId: 'usr-9' }, body: { role: 'admin' }, user: ADMIN }, spyRes(), makeNext());
          await adminController.changeUserRole({ params: { userId: 'usr-9' }, body: { role: 'admin' }, user: ADMIN }, spyRes(), makeNext());
        });
      }
    );
    assert.equal(webhooks.length, 2);
  } finally {
    m.mock.restore();
  }
});

test('changeUserRole: demote NÃO gera alerta de escalada (role != admin)', async () => {
  await withPrisma(
    {
      'user.findUnique': async () => ({ id: 'usr-12', email: 'adm12@x.com', role: 'admin', status: 'active' }),
      'user.count': async () => 2,
      'role.findUnique': async () => ({ id: 'r-user', code: 'user' }),
      'user.update': async () => ({ id: 'usr-12', email: 'adm12@x.com', role: 'user' }),
    },
    async () => {
      await withSinks(async () => {
        const res = spyRes();
        await adminController.changeUserRole(
          { params: { userId: 'usr-12' }, body: { role: 'user' }, user: { ...ADMIN, id: 'adm-99' } },
          res,
          makeNext()
        );
        assert.equal(res.statusCode, 200);
        assert.equal(webhooks.length, 0);
      });
    }
  );
});

// ── admin.user_deleted ───────────────────────────────────────

test('deleteUser: exclusão confirmada dispara admin.user_deleted (com timestamp)', async () => {
  await withPrisma(
    {
      'user.findUnique': async () => ({ ...TARGET_USER }),
      'user.delete': async () => ({ id: 'usr-9', email: 'alvo@example.com' }),
    },
    async () => {
      await withSinks(async () => {
        const res = spyRes();
        await adminController.deleteUser(
          { params: { userId: 'usr-9' }, body: { confirm: true }, user: ADMIN },
          res,
          makeNext()
        );
        assert.equal(res.statusCode, 200);
        assert.equal(webhooks.length, 1);
        assert.ok(webhooks[0].includes('admin.user_deleted:usr-9:'));
        assert.ok(webhooks[0].includes('alvo@example.com'));
        assert.ok(webhooks[0].includes('root@example.com'));
      });
    }
  );
});

test('deleteUser: sem confirm, toca banco? NÃO — 422 e NENHUM alerta', async () => {
  let deleteCalled = false;
  await withPrisma(
    {
      'user.findUnique': async () => { return null; },
      'user.delete': async () => { deleteCalled = true; return { id: 'usr-9', email: 'alvo@example.com' }; },
    },
    async () => {
      await withSinks(async () => {
        const res = spyRes();
        await adminController.deleteUser(
          { params: { userId: 'usr-9' }, body: {}, user: ADMIN },
          res,
          makeNext()
        );
        assert.equal(res.statusCode, 422);
        assert.equal(webhooks.length, 0);
        assert.equal(deleteCalled, false);
      });
    }
  );
});

// ── bulk (mesmos caminhos) ───────────────────────────────────

test('bulkUserActions: promote + delete por item geram os MESMOS alertas', async () => {
  const mNow = mock.method(Date, 'now', () => 3000000000000);
  try {
    await withPrisma(
      {
        'user.findUnique': async ({ where }) => {
          if (where && where.id === 'usr-9') return { ...TARGET_USER };
          if (where && where.id === 'usr-10') return { ...TARGET_USER2 };
          if (where && where.id === 'usr-11') return { id: 'usr-11', email: 'alvo3@example.com', role: 'user', status: 'active' };
          return null;
        },
        'role.findUnique': async () => ({ id: 'r-admin', code: 'admin' }),
        'user.update': async () => ({ ...TARGET_USER, role: 'admin' }),
        'user.delete': async () => ({ id: 'usr-11', email: 'alvo3@example.com' }),
      },
      async () => {
        await withSinks(async () => {
          const res = spyRes();
          await adminController.bulkUserActions(
            {
              body: {
                items: [
                  { userId: 'usr-9', action: 'promote' },
                  { userId: 'usr-10', action: 'promote' },
                  { userId: 'usr-11', action: 'delete', confirm: true },
                ],
              },
              user: ADMIN,
            },
            res,
            makeNext()
          );
          assert.equal(res.statusCode, 200);
          assert.equal(res.jsonBody.data.applied, 3);
        });
      }
    );
    assert.equal(webhooks.length, 3);
    assert.ok(webhooks.some((w) => w.includes('admin.role_escalation:usr-9:')));
    assert.ok(webhooks.some((w) => w.includes('admin.role_escalation:usr-10:')));
    assert.ok(webhooks.some((w) => w.includes('admin.user_deleted:usr-11:')));
  } finally {
    mNow.mock.restore();
  }
});

// ── auth.register_rate_limited (integração com o limiter real) ─

test('registerLimiter: 429 dispara o alerta UMA vez (cooldown) e a resposta não vaza IP', async () => {
  const savedReg = config.rateLimit.register;
  const savedRedis = config.redis.distributedEnabled;
  const savedCooldown = config.alerts.cooldownMs;
  let server;
  try {
    config.rateLimit.register = 3;
    config.redis.distributedEnabled = false;
    config.alerts.cooldownMs = 1_800_000;
    redisStore.resetAvailabilityCache();
    await withSinks(async () => {
      const express = require('express');
      const rateLimiter = require('../src/middlewares/rateLimiter');
      const app = express();
      app.use(express.json());
      app.post('/api/auth/register', rateLimiter.registerLimiter, (req, res) => res.status(200).json({ ok: true }));
      await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
      const base = `http://127.0.0.1:${server.address().port}`;
      const statuses = [];
      for (let i = 0; i < 5; i++) {
        const r = await fetch(`${base}/api/auth/register`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: `e${i}@x.com`, password: 'NovaSenha1!' }),
        });
        statuses.push(r.status);
        if (r.status === 429) {
          const body = await r.json();
          assert.equal(body.success, false);
          assert.ok(!JSON.stringify(body).includes('127.0.0.1'), '429 público genérico — IP só no alerta');
        }
      }
      assert.deepEqual(statuses, [200, 200, 200, 429, 429]);
      await flushMicro();
      assert.equal(webhooks.length, 1, 'rate limit repetido → UMA notificação (cooldown)');
      assert.ok(webhooks[0].includes('auth.register_rate_limited'));
      assert.ok(webhooks[0].includes('127.0.0.1'));
    });
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    config.rateLimit.register = savedReg;
    config.redis.distributedEnabled = savedRedis;
    config.alerts.cooldownMs = savedCooldown;
    redisStore.resetAvailabilityCache();
    alertService._setSinks(null);
    alertService.resetCooldown();
  }
});