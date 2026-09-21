'use strict';

/**
 * Guardas e wire dos handlers admin de usuários (adminController):
 *  - anti-self-lockout: nunca bloquear/excluir/demover a própria conta (422);
 *  - último admin ativo protegido contra bloqueio/demote/exclusão (422);
 *  - exclusão exige `confirm: true` no corpo mesmo além do schema Joi;
 *  - DTO whitelist nas respostas, mesmo com objeto "gordo" do banco.
 *
 * O cliente Prisma é Proxy-based (quebra mock.method do node:test) — usa-se
 * substituição manual com restauração em finally (padrão do repositório já
 * validado em REV 1/2).
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const alertService = require('../src/services/alertService');

// Alertas de eventos de usuário passam a existir (role_escalation etc.):
// instalando sinks de captura nas rotas, NENHUM alerta de teste sai para o
// webhook/e-mail REAL configurado no .env.
before(() => {
  alertService.resetCooldown();
  alertService._setSinks({ sendEmail: async () => true, sendWebhook: async () => true });
});
after(() => {
  alertService._setSinks(null);
  alertService.resetCooldown();
});

// Teste de ISOLAMENTO: o ChannelHealthService faz auto-start de checagens ao
// ser construído com um m3uService (91 probes paralelos em runtime). Em teste
// isso abriria dezenas de sockets e travaria a saída do runner. Substituímos o
// módulo ANTES de importar o controlador — em produção o auto-start é real.
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
const adminController = require('../src/controllers/adminController');

const ADMIN = { id: 'adm-1', name: 'Root', email: 'root@example.com', role: 'admin', status: 'active' };
const TARGET = { id: 'usr-9', name: 'Alvo', email: 'alvo@example.com', role: 'user', status: 'active', accountRestricted: false };
const FAT_TARGET = { ...TARGET, password: 'hash', apiToken: 'jwt.x', sessionVersion: 3 };

const ROLE_USER = { id: 'role-user', code: 'user' };

function spyRes() {
  const res = { statusCode: null, jsonBody: null, sent: false };
  res.status = function (code) { this.statusCode = code; return this; };
  res.json = function (body) { this.jsonBody = body; this.sent = true; return this; };
  return res;
}

// next que propaga o erro (como o errorHandler faria) → os casos que "lançam"
// viram rejeição de Promise testável com assert.rejects.
function makeNext() {
  const next = (err) => { if (err) throw err; return undefined; };
  return next;
}

function withPrismaMocks(mocks, fn) {
  const saved = {
    'user.findUnique': prisma.user.findUnique,
    'user.findMany': prisma.user.findMany,
    'user.count': prisma.user.count,
    'user.update': prisma.user.update,
    'user.delete': prisma.user.delete,
    'role.findUnique': prisma.role.findUnique,
    'auditLog.create': prisma.auditLog.create,
  };

  const setPath = (path, value) => {
    const parts = path.split('.');
    let obj = prisma;
    for (let i = 0; i < parts.length - 1; i++) obj = obj[parts[i]];
    obj[parts[parts.length - 1]] = value;
  };

  // Auditoria é fire-and-forget; no-op evita conexão real com o banco
  // (que manteria o pool aberto e travaria a saída do runner).
  for (const [path, mock] of Object.entries(mocks || {})) setPath(path, mock);
  setPath('auditLog.create', async () => ({}));

  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [path, orig] of Object.entries(saved)) setPath(path, orig);
    });
}

test('deleteUser: sem `confirm: true` → 422 sem tocar no banco', async () => {
  await withPrismaMocks({}, async () => {
    const res = spyRes();
    let called = false;
    prisma.user.findUnique = async () => { called = true; return null; };
    await adminController.deleteUser({ params: { userId: 'x' }, body: {}, user: ADMIN }, res, makeNext());
    assert.equal(res.statusCode, 422);
    assert.ok(String(res.jsonBody.message).includes('confirm'));
    assert.equal(called, false);
  });
});

test('setUserBlock: bloquear a PRÓPRIA conta é recusado (422)', async () => {
  await withPrismaMocks({ 'user.findUnique': async () => ({ ...ADMIN }) }, async () => {
    await assert.rejects(
      () => adminController.setUserBlock({ params: { userId: 'adm-1' }, body: { blocked: true, reason: '' }, user: ADMIN }, spyRes(), makeNext()),
      (err) => err.statusCode === 422
    );
  });
});

test('changeUserRole: demover o próprio admin (demote self) é recusado (422)', async () => {
  await withPrismaMocks(
    { 'user.findUnique': async () => ({ ...ADMIN }), 'role.findUnique': async () => ROLE_USER },
    async () => {
      await assert.rejects(
        () => adminController.changeUserRole({ params: { userId: 'adm-1' }, body: { role: 'user' }, user: ADMIN }, spyRes(), makeNext()),
        (err) => err.statusCode === 422
      );
    }
  );
});

test('deleteUser: excluir o último admin ativo é recusado apesar do confirm (422)', async () => {
  await withPrismaMocks(
    {
      'user.findUnique': async () => ({ id: 'adm-2', role: 'admin', status: 'active', email: 'adm2@ex.com' }),
      'user.count': async () => 1,
    },
    async () => {
      const res = spyRes();
      await adminController.deleteUser({ params: { userId: 'adm-2' }, body: { confirm: true }, user: ADMIN }, res, makeNext());
      assert.equal(res.statusCode, 422);
      assert.ok(String(res.jsonBody.message).includes('último admin'));
    }
  );
});

test('setUserBlock: bloquear o último admin ativo é recusado (422)', async () => {
  await withPrismaMocks(
    {
      'user.findUnique': async () => ({ id: 'adm-2', role: 'admin', status: 'active', email: 'adm2@ex.com' }),
      'user.count': async () => 1,
    },
    async () => {
      const res = spyRes();
      await adminController.setUserBlock({ params: { userId: 'adm-2' }, body: { blocked: true, reason: '' }, user: ADMIN }, res, makeNext());
      assert.equal(res.statusCode, 422);
    }
  );
});

test('changeRole: rebaixar o último admin ativo é recusado (422)', async () => {
  await withPrismaMocks(
    {
      'user.findUnique': async () => ({ id: 'adm-2', role: 'admin', status: 'active', email: 'adm2@ex.com' }),
      'user.count': async () => 1,
      'role.findUnique': async () => ROLE_USER,
    },
    async () => {
      const res = spyRes();
      await adminController.changeUserRole({ params: { userId: 'adm-2' }, body: { role: 'user' }, user: ADMIN }, res, makeNext());
      assert.equal(res.statusCode, 422);
    }
  );
});

test('listUsers: busca + filtro de status + cap de limit, sem vazar campos sensíveis', async () => {
  let captured = {};
  await withPrismaMocks(
    {
      'user.findMany': async (args) => { captured = args; return [FAT_TARGET]; },
      'user.count': async () => 1,
    },
    async () => {
      const res = spyRes();
      await adminController.listUsers({ query: { page: '1', limit: '999', search: '  Alvo ', status: 'active' } }, res, makeNext());
      assert.equal(res.statusCode, 200);
      assert.equal(captured.take, 500);
      assert.equal(captured.where.status, 'active');
      assert.equal(captured.where.OR[0].name.contains, 'Alvo');
      assert.equal(captured.where.OR[0].name.mode, 'insensitive');
      assert.equal(captured.where.OR[1].email.contains, 'Alvo');
      const out = res.jsonBody.data.users[0];
      assert.equal(out.name, 'Alvo');
      assert.equal('password' in out, false);
      assert.equal('apiToken' in out, false);
      assert.equal(res.jsonBody.data.total, 1);
      assert.equal(res.jsonBody.data.limit, 500);
    }
  );
});

test('getUser: responde DTO whitelist e 404 quando não existe', async () => {
  await withPrismaMocks({ 'user.findUnique': async () => ({ ...FAT_TARGET }) }, async () => {
    const res = spyRes();
    await adminController.getUser({ params: { userId: 'usr-9' }, ip: '127.0.0.1' }, res, makeNext());
    assert.equal(res.statusCode, 200);
    const out = res.jsonBody.data.user;
    assert.equal(out.email, 'alvo@example.com');
    assert.equal('password' in out, false);
    assert.equal('sessionVersion' in out, false);
  });

  await withPrismaMocks({ 'user.findUnique': async () => null }, async () => {
    const res = spyRes();
    await adminController.getUser({ params: { userId: 'nao-existe' } }, res, makeNext());
    assert.equal(res.statusCode, 404);
  });
});

test('changePassword: senha fraca é recusada como defesa em profundidade (422)', async () => {
  let updateCalled = false;
  await withPrismaMocks(
    {
      'user.findUnique': async () => ({ ...TARGET }),
      'user.update': async () => { updateCalled = true; return null; },
    },
    async () => {
      await assert.rejects(
        () => adminController.changePassword({ params: { userId: 'usr-9' }, body: { newPassword: 'fraca' }, user: ADMIN }, spyRes(), makeNext()),
        (err) => err.statusCode === 422
      );
      assert.equal(updateCalled, false);
    }
  );
});

test('changePassword: usuário inexistente → 404', async () => {
  await withPrismaMocks({ 'user.findUnique': async () => null }, async () => {
    const res = spyRes();
    await adminController.changePassword({ params: { userId: 'ghost' }, body: { newPassword: 'SenhaForte123' }, user: ADMIN }, res, makeNext());
    assert.equal(res.statusCode, 404);
  });
});

test('updateProfile: e-mail já usado por OUTRO usuário → 409 sem atualizar', async () => {
  let updateCalled = false;
  await withPrismaMocks(
    {
      'user.findUnique': async ({ where }) => {
        if (where && where.id === 'usr-9') return { ...TARGET };
        if (where && where.email === 'outra@ex.com') return { id: 'usr-other', email: 'outra@ex.com' };
        return null;
      },
      'user.update': async () => { updateCalled = true; return null; },
    },
    async () => {
      const res = spyRes();
      await adminController.updateProfile({ params: { userId: 'usr-9' }, body: { email: 'OUTRA@ex.com' }, user: ADMIN }, res, makeNext());
      assert.equal(res.statusCode, 409);
      assert.equal(updateCalled, false);
    }
  );
});