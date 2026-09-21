'use strict';

/**
 * Avise-me — Regras de negócio do reminderService:
 *  - canal deve existir na M3U (fonte de verdade, sem banco de canais);
 *  - título obrigatório (≤255), início futuro, horizonte máximo, stop > start;
 *  - duplicado (userId+channelId+startsAt) → 409; limite por usuário → 422;
 *  - kill switch FEATURE_DISABLED → 400;
 *  - ownership rigorosa: delete/mark exigem (userId, id) — lembrete de outro
 *    usuário NUNCA é alcançável (404), mesmo conhecendo o id (IDOR).
 *
 * O repository e o M3UService reais fariam I/O/requisição em rede → ambos
 * substituídos via require.cache ANTES de importar o serviço (padrão dos
 * demais testes de persistência).
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// ── Isolamento de dependências ─────────────────────────────────
const M3U_PATH = require.resolve('../src/services/m3uService');
class FakeM3UService {
  static getShared() {
    if (!FakeM3UService._shared) FakeM3UService._shared = new FakeM3UService();
    return FakeM3UService._shared;
  }
  constructor() {
    this.channels = [{ id: 'ch-1', name: 'Globo HD', cleanName: 'Globo', category: 'Filmes', logo: '' }];
  }
  getChannelById(id) { return this.channels.find((c) => c.id === id) || null; }
  getAllChannels() { return this.channels; }
  async ensureLoaded() { return this; }
}
FakeM3UService._shared = null;
require.cache[M3U_PATH] = { id: M3U_PATH, filename: M3U_PATH, loaded: true, exports: FakeM3UService };

const REPO_PATH = require.resolve('../src/repositories/programReminderRepository');
let repoCalls = null;
let repoImpl = null;
require.cache[REPO_PATH] = {
  id: REPO_PATH,
  filename: REPO_PATH,
  loaded: true,
  exports: new Proxy({}, {
    get(_t, prop) {
      return async (...args) => {
        if (!repoCalls) repoCalls = { list: 0, findOwned: [], findExisting: [], count: 0, create: [], remove: [], mark: [], due: [] };
        repoCalls[prop] = repoCalls[prop] || [];
        repoCalls[prop].push(args);
        // O serviço segura esta referência fixa (Proxy). Para o `restubRepo`
        // surtir efeito, o chamador real é `repoImpl` (mutável), nunca exports.
        if (typeof repoImpl !== 'undefined' && repoImpl !== null && typeof repoImpl[prop] === 'function') {
          return repoImpl[prop](...args);
        }
        return undefined;
      };
    },
  }),
};

const config = require('../src/config/app');
const { snapshot } = require('../src/utils/metrics');

// ── Isolamento do Redis (Upstash) — marcador de estado do botão ──
const REDIS_PATH = require.resolve('../src/services/redisStore');
let storeCalls = null;
let storeBehavior = null;
const storeStub = {};
function doStore(method, args) {
  if (storeCalls) storeCalls.push([method, ...args]);
  if (storeBehavior && typeof storeBehavior[method] === 'function') {
    return storeBehavior[method](...args);
  }
  const defaults = {
    makeKey: (...p) => ['sventv', ...p].join(':'),
    setWithTTL: async () => true,
    get: async () => null,
    del: async () => 1,
  };
  return defaults[method](...args);
}
storeStub.makeKey = (...args) => doStore('makeKey', args);
storeStub.setWithTTL = (...args) => doStore('setWithTTL', args);
storeStub.get = (...args) => doStore('get', args);
storeStub.del = (...args) => doStore('del', args);
require.cache[REDIS_PATH] = { id: REDIS_PATH, filename: REDIS_PATH, loaded: true, exports: storeStub };

const reminderService = require('../src/services/reminderService');

beforeEach(() => { repoCalls = null; repoImpl = null; storeCalls = []; storeBehavior = null; });

function restubRepo(impl) {
  repoImpl = impl;
}

function makeRow(over = {}) {
  return {
    id: 'rem-1',
    channelId: 'ch-1',
    title: 'Jornal Hoje',
    startsAt: new Date('2026-09-20T20:00:00.000Z'),
    stopAt: new Date('2026-09-20T21:00:00.000Z'),
    notifiedAt: null,
    createdAt: new Date('2026-09-18T10:00:00.000Z'),
    ...over,
  };
}

const future = () => new Date(Date.now() + 2 * 3600 * 1000).toISOString();
const past = () => new Date(Date.now() - 2 * 3600 * 1000).toISOString();

// ── Validação ─────────────────────────────────────────────────

test('createReminder: canal inexistente na M3U → 404 NOT_FOUND sem tocar o repo', async () => {
  restubRepo({
    findExisting: async () => null,
    countActive: async () => 0,
    create: async () => makeRow(),
  });
  await assert.rejects(
    () => reminderService.createReminder('u1', { channelId: 'nao-existe', title: 'X', startsAt: future() }),
    (e) => e.statusCode === 404 && e.code === 'NOT_FOUND'
  );
  assert.ok(!repoCalls || (!repoCalls.findExisting && !repoCalls.create));
});

test('createReminder: título vazio → 422', async () => {
  restubRepo({ findExisting: async () => null, countActive: async () => 0, create: async () => makeRow() });
  await assert.rejects(
    () => reminderService.createReminder('u1', { channelId: 'ch-1', title: '  ', startsAt: future() }),
    (e) => e.statusCode === 422
  );
});

test('createReminder: início no passado → 422', async () => {
  restubRepo({ findExisting: async () => null, countActive: async () => 0, create: async () => makeRow() });
  await assert.rejects(
    () => reminderService.createReminder('u1', { channelId: 'ch-1', title: 'Jornal', startsAt: past() }),
    (e) => e.statusCode === 422 && e.message.includes('futuro')
  );
});

test('createReminder: além do horizonte (16 dias) → 422', async () => {
  restubRepo({ findExisting: async () => null, countActive: async () => 0, create: async () => makeRow() });
  await assert.rejects(
    () => reminderService.createReminder('u1', { channelId: 'ch-1', title: 'Jornal', startsAt: new Date(Date.now() + 16 * 24 * 3600 * 1000).toISOString() }),
    (e) => e.statusCode === 422 && e.message.includes('distante')
  );
});

test('createReminder: stop não posterior ao início → 422', async () => {
  restubRepo({ findExisting: async () => null, countActive: async () => 0, create: async () => makeRow() });
  const start = new Date(Date.now() + 2 * 3600 * 1000);
  await assert.rejects(
    () => reminderService.createReminder('u1', { channelId: 'ch-1', title: 'Jornal', startsAt: start.toISOString(), stopAt: new Date(start.getTime() - 1000).toISOString() }),
    (e) => e.statusCode === 422 && e.message.includes('posterior')
  );
});

test('createReminder: duplicado (mesmo userId+channelId+startsAt) → 409 DUPLICATE', async () => {
  let createCalled = 0;
  restubRepo({
    findExisting: async () => makeRow(),
    countActive: async () => 1,
    create: async () => { createCalled += 1; return makeRow(); },
  });
  await assert.rejects(
    () => reminderService.createReminder('u1', { channelId: 'ch-1', title: 'Jornal', startsAt: future() }),
    (e) => e.statusCode === 409 && e.code === 'DUPLICATE'
  );
  assert.equal(createCalled, 0, 'nenhuma escrita em duplicado');
  assert.ok(snapshot().counters.remindersDuplicateRejected >= 1);
});

test('createReminder: limite de 50 ativos por usuário → 422', async () => {
  let createCalled = 0;
  const max = config.reminders.maxPerUser;
  restubRepo({
    findExisting: async () => null,
    countActive: async () => max,
    create: async () => { createCalled += 1; return makeRow(); },
  });
  await assert.rejects(
    () => reminderService.createReminder('u1', { channelId: 'ch-1', title: 'Jornal', startsAt: future() }),
    (e) => e.statusCode === 422 && e.message.includes('Limite')
  );
  assert.equal(createCalled, 0);
});

test('createReminder: sucesso cria com snapshot e incrementa métrica', async () => {
  let stored = null;
  restubRepo({
    findExisting: async () => null,
    countActive: async () => 0,
    create: async (data) => { stored = data; return makeRow({ id: 'rem-novo' }); },
  });
  const start = new Date(Date.now() + 2 * 3600 * 1000);
  const out = await reminderService.createReminder('u1', {
    channelId: 'ch-1',
    title: '  Jornal Hoje  ',
    startsAt: start.toISOString(),
    stopAt: new Date(start.getTime() + 3600 * 1000).toISOString(),
  });
  assert.equal(out.id, 'rem-novo');
  assert.equal(stored.userId, 'u1');
  assert.equal(stored.channelId, 'ch-1');
  assert.equal(stored.title, 'Jornal Hoje', 'título é limpo (trim) antes de persistir');
  assert.ok(snapshot().counters.remindersCreated >= 1);
});

test('createReminder: kill switch (enabled=false) → 400 FEATURE_DISABLED', async () => {
  const prev = config.reminders.enabled;
  config.reminders.enabled = false;
  try {
    restubRepo({ findExisting: async () => null, countActive: async () => 0, create: async () => makeRow() });
    await assert.rejects(
      () => reminderService.createReminder('u1', { channelId: 'ch-1', title: 'Jornal', startsAt: future() }),
      (e) => e.statusCode === 400 && e.code === 'FEATURE_DISABLED'
    );
  } finally {
    config.reminders.enabled = prev;
  }
});

test('listReminders: desabilitado devolve [] e não consulta o banco', async () => {
  const prev = config.reminders.enabled;
  config.reminders.enabled = false;
  try {
    const out = await reminderService.listReminders('u1', {});
    assert.deepEqual(out, []);
  } finally {
    config.reminders.enabled = prev;
  }
});

test('listReminders: repassa trailMs ao repositório (janela de recuperação)', async () => {
  let captured = null;
  restubRepo({ listByUser: async (userId, opts) => { captured = opts; return []; } });
  const out = await reminderService.listReminders('u1', { limit: 20, upcoming: true, trailMs: 900000 });
  assert.deepEqual(out, []);
  assert.equal(captured.limit, 20);
  assert.equal(captured.upcoming, true);
  assert.equal(captured.trailMs, 900000, 'trail flui até a query do banco');
});

// ── Ownership (IDOR) ───────────────────────────────────────────

test('deleteReminder: lembrete de OUTRO usuário nunca é alcançável → 404 (IDOR)', async () => {
  restubRepo({
    findOwned: async (userId, id) => {
      assert.equal(userId, 'u1'); // ownership SEMPRE do token, nunca do id
      return null; // findFirst id+userId não encontrou nada
    },
    remove: async () => { throw new Error('remove não deveria rodar'); },
  });
  await assert.rejects(
    () => reminderService.deleteReminder('u1', 'rem-de-outro-usuario'),
    (e) => e.statusCode === 404
  );
});

test('markNotified: confirma apenas lembrete próprio e não notificado', async () => {
  let marks = 0;
  restubRepo({
    markNotified: async (userId, id) => {
      // userId vem do token (prova de que o param é passado — anti-IDOR)
      assert.equal(userId, 'u1');
      marks += 1;
      return true;
    },
  });
  const ok = await reminderService.markNotified('u1', 'rem-1');
  assert.equal(ok, true);
  assert.equal(marks, 1);
  assert.ok(snapshot().counters.remindersNotified >= 1);
});

test('markNotified: já notificado é idempotente (não é erro)', async () => {
  restubRepo({
    markNotified: async () => false, // updateMany com notifiedAt:null → 0 linhas
    findOwned: async () => makeRow({ notifiedAt: new Date() }), // existe e é nosso
  });
  const ok = await reminderService.markNotified('u1', 'rem-1');
  assert.equal(ok, true, 'repetida confirmação é sucesso silencioso');
});

test('markNotified: se não existe/não é nosso → 404', async () => {
  restubRepo({
    markNotified: async () => false,
    findOwned: async () => null,
  });
  await assert.rejects(
    () => reminderService.markNotified('u1', 'rem-nao-nosso'),
    (e) => e.statusCode === 404
  );
});

// ── runDueReminders (cron de e-mail) ───────────────────────────

function dueRow(over = {}) {
  return makeRow({ userId: 'u1', ...over });
}

test('runDueReminders: desabilitado → no-op ({enabled:false}) sem consultar findDue', async () => {
  const prev = config.reminders.enabled;
  config.reminders.enabled = false;
  try {
    restubRepo({ findDue: async () => { throw new Error('findDue NÃO deveria rodar'); } });
    const out = await reminderService.runDueReminders({ now: Date.now() });
    assert.equal(out.enabled, false);
    assert.equal(out.sent, 0);
  } finally {
    config.reminders.enabled = prev;
  }
});

test('runDueReminders: canal de e-mail desligado (emailEnabled=false) → no-op sem consultar findDue/SMTP', async () => {
  const prev = config.reminders.emailEnabled;
  config.reminders.emailEnabled = false;
  try {
    restubRepo({ findDue: async () => { throw new Error('findDue NÃO deveria rodar'); } });
    const out = await reminderService.runDueReminders({ now: Date.now() });
    assert.equal(out.enabled, true);
    assert.equal(out.emailEnabled, false);
    assert.equal(out.sent, 0);
    assert.equal(out.examined, 0);
  } finally {
    config.reminders.emailEnabled = prev;
  }
});

test('runDueReminders: envia e-mail e marca notifiedAt (best-effort idempotente)', async () => {
  let emailed = null;
  let marked = [];
  restubRepo({
    findDue: async (start, end, q) => {
      assert.ok(q.limit >= 1, 'batchLimit aplicado');
      assert.ok(end > start, 'janela à frente');
      return [dueRow({ id: 'rem-d1', channelId: 'ch-1', title: 'Jornal Hoje', startsAt: Date.now() + 60_000 })];
    },
    markNotifiedById: async (id) => { marked.push(id); return { count: 1 }; },
  });
  const out = await reminderService.runDueReminders({
    now: Date.now(),
    emailProvider: async (payload) => { emailed = payload; return { messageId: 'm1' }; },
    userProvider: async (userId) => ({ id: userId, email: 'u@exemplo.com' }),
  });

  assert.equal(out.sent, 1);
  assert.equal(out.failed, 0);
  assert.equal(out.skipped, 0);
  assert.equal(emailed.email, 'u@exemplo.com');
  assert.equal(emailed.channelName, 'Globo HD', 'nome vindo da M3U (never id)');
  assert.equal(emailed.programTitle, 'Jornal Hoje');
  assert.ok(emailed.startsAt > Date.now() - 1000, 'startsAt em ms');
  assert.deepEqual(marked, ['rem-d1'], 'marca após envio com sucesso');
  assert.ok(snapshot().counters.remindersEmailsSent >= 1);
});

test('runDueReminders: falha no envio NÃO marca notifiedAt (cron seguinte re-tenta)', async () => {
  let emailed = 0;
  let marked = [];
  restubRepo({
    findDue: async () => [dueRow({ id: 'rem-d2', channelId: 'ch-1', startsAt: Date.now() + 60_000 })],
    markNotifiedById: async (id) => { marked.push(id); return { count: 1 }; },
  });
  const out = await reminderService.runDueReminders({
    now: Date.now(),
    emailProvider: async () => { emailed += 1; throw new Error('SMTP n/a'); },
    userProvider: async () => ({ id: 'u1', email: 'u@exemplo.com' }),
  });

  assert.equal(out.sent, 0);
  assert.equal(out.failed, 1);
  assert.equal(emailed, 1);
  assert.deepEqual(marked, [], 'falha de e-mail ⇒ lembrete permanece pendente');
  assert.ok(snapshot().counters.remindersEmailFailures >= 1);
});

test('runDueReminders: usuário sem e-mail/orfão → skip (nada envia, nada marca)', async () => {
  let emailed = 0;
  let marked = [];
  restubRepo({
    findDue: async () => [
      dueRow({ id: 'rem-s1', channelId: 'ch-1', startsAt: Date.now() + 60_000 }),
      dueRow({ id: 'rem-s2', channelId: 'ch-1', startsAt: Date.now() + 120_000 }),
    ],
    markNotifiedById: async (id) => { marked.push(id); return { count: 1 }; },
  });
  const out = await reminderService.runDueReminders({
    now: Date.now(),
    emailProvider: async () => { emailed += 1; return {}; },
    userProvider: async () => null, // usuário excluído/orfão sempre
  });

  assert.equal(out.skipped, 2);
  assert.equal(out.sent, 0);
  assert.equal(out.failed, 0);
  assert.equal(emailed, 0);
  assert.deepEqual(marked, []);
});

test('runDueReminders: falha ao marcar notifiedAt não derruba o run (swallow best-effort)', async () => {
  let emailed = 0;
  restubRepo({
    findDue: async () => [dueRow({ id: 'rem-d3', channelId: 'ch-1', startsAt: Date.now() + 60_000 })],
    markNotifiedById: async () => { throw new Error('banco fora'); },
  });
  const out = await reminderService.runDueReminders({
    now: Date.now(),
    emailProvider: async () => { emailed += 1; return {}; },
    userProvider: async () => ({ id: 'u1', email: 'u@exemplo.com' }),
  });

  assert.equal(out.sent, 1);
  assert.equal(out.failed, 0, 'falha de mark não entra como falha de envio');
  assert.equal(emailed, 1);
});

test('runDueReminders: canal sumiu da M3U → fallback para channelId (sem lançar)', async () => {
  let emailed = null;
  restubRepo({
    findDue: async () => [dueRow({ id: 'rem-d4', channelId: 'sumiu', startsAt: Date.now() + 60_000 })],
    markNotifiedById: async () => ({ count: 1 }),
  });
  const out = await reminderService.runDueReminders({
    now: Date.now(),
    emailProvider: async (p) => { emailed = p; return {}; },
    userProvider: async () => ({ id: 'u1', email: 'u@exemplo.com' }),
  });
  assert.equal(out.sent, 1);
  assert.equal(emailed.channelName, 'sumiu', 'id do canal como fallback legível');
});

// ── Estado persistido do botão "Avise-me" (Redis + banco) ──────

test('createReminder: sucesso grava marcador no Redis (chave canal+início, TTL posterior ao início)', async () => {
  restubRepo({ findExisting: async () => null, countActive: async () => 0, create: async () => makeRow() });
  storeCalls = [];
  const start = new Date(Date.now() + 2 * 3600 * 1000);
  await reminderService.createReminder('u1', { channelId: 'ch-1', title: 'Jornal Hoje', startsAt: start.toISOString() });
  const setCalls = storeCalls.filter(([m]) => m === 'setWithTTL');
  assert.equal(setCalls.length, 1, 'marcador gravado uma vez');
  const [, key, value, ttlMs] = setCalls[0];
  assert.ok(key.includes('rem:active:u1:ch-1:'), `chave com identidade de lembrete: ${key}`);
  assert.ok(key.endsWith(String(start.getTime())), 'chave termina no início do programa (ms)');
  assert.equal(value, '1');
  assert.ok(ttlMs >= start.getTime() - Date.now(), 'TTL vale até depois do programa começar');
});

test('createReminder: falha do Redis NÃO derruba o 201 (fail-open)', async () => {
  restubRepo({ findExisting: async () => null, countActive: async () => 0, create: async () => makeRow() });
  storeBehavior = { setWithTTL: async () => { throw new Error('redis fora'); } };
  const out = await reminderService.createReminder('u1', { channelId: 'ch-1', title: 'Jornal', startsAt: future() });
  assert.equal(out.id, 'rem-1');
});

test('hasActiveReminder: hit no Redis → true SEM consultar o banco (fast-path)', async () => {
  let repoHits = 0;
  restubRepo({ findExisting: async () => { repoHits += 1; return makeRow(); } });
  storeBehavior = { get: async () => '1' };
  const start = Date.now() + 3600_000;
  const ok = await reminderService.hasActiveReminder('u1', 'ch-1', start);
  assert.equal(ok, true);
  assert.equal(repoHits, 0, 'Redis é fast-path — banco nem é consultado');
});

test('hasActiveReminder: miss no Redis → banco é a fonte de verdade + write-back', async () => {
  let writeBack = 0;
  restubRepo({ findExisting: async () => makeRow() });
  storeBehavior = { get: async () => null, setWithTTL: async () => { writeBack += 1; return true; } };
  const start = Date.now() + 3600_000;
  const ok = await reminderService.hasActiveReminder('u1', 'ch-1', start);
  assert.equal(ok, true);
  assert.equal(writeBack, 1, 'write-back esquenta o fast-path para as próximas consultas');
});

test('hasActiveReminder: sem lembrete → false (Redis miss + banco null)', async () => {
  restubRepo({ findExisting: async () => null });
  const start = Date.now() + 3600_000;
  assert.equal(await reminderService.hasActiveReminder('u1', 'ch-1', start), false);
});

test('hasActiveReminder: kill switch da feature → false sem tocar Redis/banco', async () => {
  const prev = config.reminders.enabled;
  config.reminders.enabled = false;
  try {
    restubRepo({ findExisting: async () => { throw new Error('não deve consultar'); } });
    storeBehavior = { get: async () => { throw new Error('não deve consultar Redis'); } };
    assert.equal(await reminderService.hasActiveReminder('u1', 'ch-1', Date.now() + 3600_000), false);
  } finally {
    config.reminders.enabled = prev;
  }
});

test('hasActiveReminder: data de início inválida → 422', async () => {
  await assert.rejects(
    () => reminderService.hasActiveReminder('u1', 'ch-1', null),
    (e) => e.statusCode === 422 && e.message.includes('Data de início')
  );
});

test('deleteReminder: sucesso remove o marcador do botão (chave canal+início)', async () => {
  const row = makeRow({ channelId: 'ch-1', startsAt: new Date(Date.now() + 3600_000) });
  restubRepo({ findOwned: async () => row, remove: async () => true });
  storeCalls = [];
  await reminderService.deleteReminder('u1', 'rem-1');
  const delCalls = storeCalls.filter(([m]) => m === 'del');
  assert.equal(delCalls.length, 1, 'marcador apagado ao remover o lembrete');
  const [, key] = delCalls[0];
  assert.ok(key.includes('ch-1') && key.endsWith(String(row.startsAt.getTime())));
});