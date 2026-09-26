'use strict';

// Processo de teste com kill switch DESLIGADO: o singleton IpBlocklistService
// default não tenta persistir (nenhum delegate ipBlocklist em runtime de teste)
// — a blocklist é exercitada em memória; o true write-through é coberto pelo
// teste unitário do serviço com repositório fake (ip-blocklist-service.test.js).
const ORIG_IP_ENABLED = process.env.IP_ACCESS_ENABLED;
process.env.IP_ACCESS_ENABLED = 'false';

/**
 * IP Access Control — endpoints admin (adminController) + schemas Joi
 * (validate.js):
 *  - listWafIps: whitelist DTO (sem password/apiToken), campos de IP e
 *    `anyIpBlocked`; filtro `ipStatus`; projeção de busca.
 *  - blockUserIp: IP do corpo deve pertencer ao usuário (422 senão);
 *    sem IP usa registrationIp ou lastLoginIp; anti-self-lockout exige
 *    confirmSelfBlock=true; audita `admin.ip_access.block`.
 *  - unblockUserIp: IP explícito pertencente ou desbloqueio do IP ativo.
 *  - getWafStatus: expõe contadores/bloco `ipAccess`.
 *  - Schemas Joi: IPv4/IPv6 válidos; razão com máx. 200; mensagens próprias.
 *
 * Cliente Prisma Proxy-based → substituição manual + restauração em finally.
 * Alerta de usuário usa sinks fake (NUNCA toca webhook/e-mail reais).
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const alertService = require('../src/services/alertService');
before(() => {
  alertService.resetCooldown();
  alertService._setSinks({ sendEmail: async () => true, sendWebhook: async () => true });
});
after(() => {
  alertService._setSinks(null);
  alertService.resetCooldown();
  if (ORIG_IP_ENABLED === undefined) delete process.env.IP_ACCESS_ENABLED;
  else process.env.IP_ACCESS_ENABLED = ORIG_IP_ENABLED;
});

// Isolamento: ChannelHealthService auto-inicia 91 probes em runtime se
// construído com o m3uService real → substitui o módulo antes do import.
const HEALTH_PATH = require.resolve('../src/services/channelHealthService');
class FakeHealthService {
  constructor() { this.statuses = new Map(); }
  startAutoChecks() {}
  stopAutoChecks() {}
  async checkChannelById() { return { ok: false, checkedAt: null, activeSource: 'primary', primary: null, backup: null }; }
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
require.cache[HEALTH_PATH] = { id: HEALTH_PATH, filename: HEALTH_PATH, loaded: true, exports: FakeHealthService };

const IpBlocklistService = require('../src/services/ipBlocklistService');
const prisma = require('../src/prisma/client');
const adminController = require('../src/controllers/adminController');
const { schemas } = require('../src/middlewares/validate');

const ADMIN = {
  id: 'adm-1', name: 'Root Admin', email: 'root@example.com', role: 'admin', status: 'active',
  registrationIp: '203.0.113.100', lastLoginIp: '203.0.113.100',
};
const TARGET = {
  id: 'usr-9', name: 'Alvo', email: 'alvo@example.com', role: 'user', status: 'active',
  accountRestricted: false, registrationIp: '203.0.113.5', lastLoginIp: '198.51.100.9',
  createdAt: '2026-09-01T00:00:00.000Z',
};

function resetBlocklistSingleton() {
  IpBlocklistService._shared = null;
}

function spyRes() {
  const res = { statusCode: null, jsonBody: null, sent: false, cookies: {} };
  res.status = function (code) { this.statusCode = code; return this; };
  res.json = function (body) { this.jsonBody = body; this.sent = true; return this; };
  res.cookie = function (k, v) { this.cookies[k] = v; };
  res.send = function (b) { this.sent = true; this.htmlBody = b; return this; };
  return res;
}

function makeNext() {
  const next = (err) => { if (err) throw err; return undefined; };
  return next;
}

function withPrismaMocks(mocks, fn) {
  const saved = {
    'user.findUnique': prisma.user.findUnique,
    'user.findMany': prisma.user.findMany,
    'user.count': prisma.user.count,
    'auditLog.create': prisma.auditLog.create,
    'auditLog.findMany': prisma.auditLog.findMany,
    'auditLog.groupBy': prisma.auditLog.groupBy,
    'ipBlocklist.upsert': prisma.ipBlocklist && prisma.ipBlocklist.upsert,
    'ipBlocklist.update': prisma.ipBlocklist && prisma.ipBlocklist.update,
    'ipBlocklist.findMany': prisma.ipBlocklist && prisma.ipBlocklist.findMany,
    'ipBlocklist.count': prisma.ipBlocklist && prisma.ipBlocklist.count,
  };

  const setPath = (path, value) => {
    const parts = path.split('.');
    let obj = prisma;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!obj[parts[i]]) obj[parts[i]] = {};
      obj = obj[parts[i]];
    }
    obj[parts[parts.length - 1]] = value;
  };

  // Se o delegate ipBlocklist ainda não existir (generate pendente), cria a
  // linha de métodos para o repositório — testes não dependem de migrate.
  if (!prisma.ipBlocklist) setPath('ipBlocklist', {});
  if (!mocks || !mocks['auditLog.create']) setPath('auditLog.create', async () => ({}));
  for (const [path, mock] of Object.entries(mocks || {})) setPath(path, mock);

  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [path, orig] of Object.entries(saved)) {
        if (orig !== undefined) setPath(path, orig);
      }
    });
}

// ── listWafIps ───────────────────────────────────────────────

test('listWafIps: DTO whitelist sem segredos, com IPs e anyIpBlocked', async () => {
  const fatUser = { ...TARGET, password: 'hash', apiToken: 'jwt.x', sessionVersion: 9 };
  await withPrismaMocks(
    {
      'user.findMany': async () => [fatUser],
      'user.count': async () => 1,
      'ipBlocklist.findMany': async () => [{ ip: '203.0.113.5', active: true, reason: 'abuso', blockedBy: 'root@example.com', blockedAt: new Date() }],
      'ipBlocklist.count': async () => 1,
    },
    async () => {
      const res = spyRes();
      await adminController.listWafIps({ query: {} }, res, makeNext());
      assert.equal(res.statusCode, 200);
      const u = res.jsonBody.data.users[0];
      assert.equal(u.id, TARGET.id);
      assert.equal(u.registrationIp, '203.0.113.5');
      assert.equal(u.anyIpBlocked, true);
      assert.equal('password' in u, false, 'DTO nunca expõe senha');
      assert.equal('apiToken' in u, false, 'DTO nunca expõe token');
      const blockedIp = u.ips.filter(x => x.ip === '203.0.113.5')[0];
      assert.equal(blockedIp.reason, 'abuso');
    }
  );
});

test('listWafIps: busca propaga OR por nome/e-mail/IP', async () => {
  let capturedWhere = null;
  await withPrismaMocks(
    {
      'user.findMany': async ({ where }) => { capturedWhere = where; return [TARGET]; },
      'user.count': async () => 1,
      'ipBlocklist.findMany': async () => [],
      'ipBlocklist.count': async () => 0,
    },
    async () => {
      const res = spyRes();
      await adminController.listWafIps({ query: { search: '203.0.113.5' } }, res, makeNext());
      assert.ok(Array.isArray(capturedWhere.OR), 'busca deve usar OR');
      const fields = capturedWhere.OR.map((c) => Object.keys(c)[0]);
      assert.ok(fields.includes('registrationIp'), 'busca deve cobrir registrationIp');
      assert.ok(fields.includes('lastLoginIp'), 'busca deve cobrir lastLoginIp');
    }
  );
});

test('listWafIps: ipStatus=blocked filtra usuários sem IP ativo', async () => {
  const freeUser = { ...TARGET, registrationIp: '192.0.2.77', lastLoginIp: '192.0.2.77' };
  const blockedUser = { ...TARGET, id: 'usr-10', name: 'Outro', email: 'outro@x.com', registrationIp: '203.0.113.90', lastLoginIp: null };
  await withPrismaMocks(
    {
      'user.findMany': async () => [freeUser, blockedUser],
      'user.count': async () => 2,
      'ipBlocklist.findMany': async () => [{ ip: '203.0.113.90', active: true, reason: '', blockedBy: null, blockedAt: new Date() }],
      'ipBlocklist.count': async () => 1,
    },
    async () => {
      const res = spyRes();
      await adminController.listWafIps({ query: { ipStatus: 'blocked' } }, res, makeNext());
      const ids = res.jsonBody.data.users.map((u) => u.id);
      assert.deepEqual(ids, ['usr-10'], 'apenas quem tem IP bloqueado deve aparecer');
    }
  );
});

// ── blockUserIp ──────────────────────────────────────────────

test('blockUserIp: sem IP no corpo, usa registrationIp do alvo e bloqueia', async () => {
  resetBlocklistSingleton();
  await withPrismaMocks({ 'user.findUnique': async () => ({ ...TARGET }) }, async () => {
    const res = spyRes();
    await adminController.blockUserIp({ params: { userId: 'usr-9' }, body: { reason: 'abuso' }, user: ADMIN }, res, makeNext());
    assert.equal(res.statusCode, 200);
    assert.match(res.jsonBody.message, /203\.0\.113\.5/);
    assert.equal(res.jsonBody.data.ip, '203.0.113.5');
  });
});

test('blockUserIp: IP explícito que NÃO pertence ao usuário → 422', async () => {
  await withPrismaMocks({ 'user.findUnique': async () => ({ ...TARGET }) }, async () => {
    const res = spyRes();
    await adminController.blockUserIp({ params: { userId: 'usr-9' }, body: { ip: '198.18.0.1' }, user: ADMIN }, res, makeNext());
    assert.equal(res.statusCode, 422);
    assert.match(res.jsonBody.message, /não pertence/);
  });
});

test('blockUserIp: usuário sem IP registrado → 422', async () => {
  await withPrismaMocks({ 'user.findUnique': async () => ({ ...TARGET, registrationIp: null, lastLoginIp: null }) }, async () => {
    const res = spyRes();
    await adminController.blockUserIp({ params: { userId: 'usr-9' }, body: {}, user: ADMIN }, res, makeNext());
    assert.equal(res.statusCode, 422);
    assert.match(res.jsonBody.message, /não possui IP registrado/);
  });
});

test('blockUserIp: bloquear o PRÓPRIO IP sem confirmSelfBlock → 422', async () => {
  await withPrismaMocks({ 'user.findUnique': async () => ({ ...ADMIN, id: 'adm-1' }) }, async () => {
    const res = spyRes();
    await adminController.blockUserIp({ params: { userId: 'adm-1' }, body: { ip: '203.0.113.100' }, user: ADMIN }, res, makeNext());
    assert.equal(res.statusCode, 422);
    assert.match(res.jsonBody.message, /confirmSelfBlock/);
  });
});

test('blockUserIp: auto-bloqueio com confirmSelfBlock=true → permitido', async () => {
  resetBlocklistSingleton();
  await withPrismaMocks({ 'user.findUnique': async () => ({ ...ADMIN, id: 'adm-1' }) }, async () => {
    const res = spyRes();
    await adminController.blockUserIp({ params: { userId: 'adm-1' }, body: { ip: '203.0.113.100', confirmSelfBlock: true }, user: ADMIN }, res, makeNext());
    assert.equal(res.statusCode, 200);
  });
});

// ── unblockUserIp ────────────────────────────────────────────

test('unblockUserIp: sem IP no corpo, desbloqueia IP do alvo ativo na blocklist', async () => {
  resetBlocklistSingleton();
  const auditCalls = [];
  await withPrismaMocks(
    {
      'user.findUnique': async () => ({ ...TARGET }),
      'ipBlocklist.findMany': async () => [{ ip: '203.0.113.5', active: true, reason: 'x', blockedBy: 'r@x', blockedAt: new Date() }],
      'ipBlocklist.update': async () => ({}),
      'auditLog.create': async (args) => { auditCalls.push(args); return {}; },
    },
    async () => {
      const res = spyRes();
      await adminController.unblockUserIp({ params: { userId: 'usr-9' }, body: {}, user: ADMIN }, res, makeNext());
      assert.equal(res.statusCode, 200);
      assert.equal(res.jsonBody.data.ip, '203.0.113.5');
      const actions = auditCalls.map((a) => a.data.action);
      assert.ok(actions.includes('admin.ip_access.unblock'), 'deve auditar unblock');
      const meta = auditCalls.find((a) => a.data.action === 'admin.ip_access.unblock').data.meta;
      assert.equal(meta.ip, '203.0.113.5');
    }
  );
});

test('unblockUserIp: IP explícito estranho ao alvo → 422', async () => {
  await withPrismaMocks({ 'user.findUnique': async () => ({ ...TARGET }) }, async () => {
    const res = spyRes();
    await adminController.unblockUserIp({ params: { userId: 'usr-9' }, body: { ip: '198.18.0.1' }, user: ADMIN }, res, makeNext());
    assert.equal(res.statusCode, 422);
  });
});

test('unblockUserIp: ninguém bloqueado → 422 "Nenhum IP deste usuário está bloqueado."', async () => {
  await withPrismaMocks(
    { 'user.findUnique': async () => ({ ...TARGET }), 'ipBlocklist.findMany': async () => [] },
    async () => {
      const res = spyRes();
      await adminController.unblockUserIp({ params: { userId: 'usr-9' }, body: {}, user: ADMIN }, res, makeNext());
      assert.equal(res.statusCode, 422);
      assert.match(res.jsonBody.message, /Nenhum IP deste usuário está bloqueado/);
    }
  );
});

// ── getWafStatus ─────────────────────────────────────────────

test('getWafStatus: expõe bloco ipAccess e contadores', async () => {
  await withPrismaMocks(
    {
      'auditLog.findMany': async () => [],
      'auditLog.groupBy': async () => [],
      'ipBlocklist.count': async () => 7,
    },
    async () => {
      const res = spyRes();
      await adminController.getWafStatus({}, res, makeNext());
      assert.equal(res.statusCode, 200);
      assert.equal(typeof res.jsonBody.data.ipAccess.enabled, 'boolean', 'kill switch refletido');
      assert.equal(typeof res.jsonBody.data.ipAccess.blockedCount, 'number');
      const c = res.jsonBody.data.counters;
      assert.ok('ipAccessBlocked' in c);
      assert.ok('ipAccessBlocksAdmin' in c);
      assert.ok('ipAccessUnblocksAdmin' in c);
    }
  );
});

// ── Schemas Joi ──────────────────────────────────────────────

function validateField(schemaName, value, opts = {}) {
  const { error, value: clean } = schemas[schemaName].validate(value, { abortEarly: false, stripUnknown: true, ...opts });
  return { error: error || null, clean };
}

test('adminWafBlock: aceita IPv4 e IPv6; rejeita IP inválido', () => {
  assert.equal(validateField('adminWafBlock', { ip: '203.0.113.7' }).error, null);
  assert.equal(validateField('adminWafBlock', { ip: '2001:db8::1' }).error, null);
  assert.equal(validateField('adminWafBlock', {}).error, null, 'ip é opcional (controller resolve do alvo)');
  const inv = validateField('adminWafBlock', { ip: 'banana' });
  assert.ok(inv.error && inv.error.details[0].message.includes('IP válido'));
});

test('adminWafBlock: reason máximo 200 chars; campos extras são descartados', () => {
  assert.equal(validateField('adminWafBlock', { reason: 'x'.repeat(200), confirmSelfBlock: false }).error, null);
  const tooLong = validateField('adminWafBlock', { reason: 'x'.repeat(201) });
  assert.ok(tooLong.error, 'reason acima de 200 deve falhar');
  const { clean } = validateField('adminWafBlock', { ip: '203.0.113.7', evil: 'hack', reason: 'motivo' });
  assert.deepEqual(Object.keys(clean).sort(), ['ip', 'reason']);
});

test('adminWafUnblock: ip opcional, inválido rejeitado', () => {
  assert.equal(validateField('adminWafUnblock', {}).error, null);
  assert.equal(validateField('adminWafUnblock', { ip: '2001:0db8:85a3::8a2e:0370:7334' }).error, null);
  assert.ok(validateField('adminWafUnblock', { ip: 'x' }).error);
});