'use strict';

const { test, mock } = require('node:test');
const assert = require('node:assert/strict');

const User = require('../src/models/User');
const metrics = require('../src/utils/metrics');
const bcrypt = require('bcryptjs');

const passwordResetCodeRepository = require('../src/repositories/passwordResetCodeRepository');
const emailService = require('../src/services/emailService');
const auditService = require('../src/services/auditService');
const { passwordResetService, PasswordResetError, hashCode, generateCode } = require('../src/services/passwordResetService');

// ── Helpers ───────────────────────────────────────────────────

const user = (over = {}) => ({
  id: 'usr-1',
  email: 'fulano@example.com',
  name: 'Fulano',
  sessionVersion: 3,
  ...over,
});

const req = { ip: '127.0.0.1', headers: {}, originalUrl: '/api/auth/reset-password' };

function mockAll({ dbUser, repo, sendFails = false }) {
  const m = {};
  m.userFind = mock.method(User, 'findByEmail', async () => dbUser);
  m.applyRepo = (r) => {
    mock.method(passwordResetCodeRepository, 'deleteUnusedForUser', r.deleteUnusedForUser || (async () => ({ count: 0 })));
    mock.method(passwordResetCodeRepository, 'create', r.create || (async () => ({ id: 'code-1' })));
    mock.method(passwordResetCodeRepository, 'findActiveForUser', r.findActiveForUser || (async () => null));
    mock.method(passwordResetCodeRepository, 'incrementAttemptIfAllowed', r.incrementAttemptIfAllowed || (async () => ({ id: 'code-1', attempts: 1 })));
    mock.method(passwordResetCodeRepository, 'invalidate', r.invalidate || (async () => ({ count: 1 })));
    mock.method(passwordResetCodeRepository, 'consumeAndSetPassword', r.consumeAndSetPassword || (async () => ({ consumed: 0, user: null })));
  };
  m.applyRepo(repo);
  if (sendFails) {
    m.send = mock.method(emailService, 'sendPasswordResetCode', async () => { throw new Error('SMTP_FAILED'); });
  } else {
    m.send = mock.method(emailService, 'sendPasswordResetCode', async () => ({ messageId: 'm1' }));
  }
  m.audit = mock.method(auditService, 'audit', async () => {});
  m.hash = mock.method(bcrypt, 'hash', async () => 'HASHED_SENHA');
  return m;
}

function restoreAll(m) {
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

// ── generateCode / hashCode ───────────────────────────────────

test('generateCode sempre devolve 6 dígitos', () => {
  for (let i = 0; i < 200; i++) {
    const c = generateCode();
    assert.match(c, /^\d{6}$/);
  }
});

test('hashCode gera sha256 hex de 64 chars e é determinístico', () => {
  const h1 = hashCode('123456');
  const h2 = hashCode('123456');
  const h3 = hashCode('654321');
  assert.equal(h1.length, 64);
  assert.equal(h1, h2);
  assert.notEqual(h1, h3);
});

// ── requestPasswordReset ──────────────────────────────────────

test('requestPasswordReset: e-mail inexistente não enumera (mesma resposta)', async () => {
  const m = mockAll({ dbUser: null, repo: {} });
  try {
    const out = await passwordResetService.requestPasswordReset({ email: 'naoexiste@x.com', req });
    assert.equal(out.ok, true);
    assert.equal(out.sent, false);           // resposta neutra
    assert.equal(m.send.mock.callCount(), 0); // NUNCA envia
  } finally {
    restoreAll(m);
  }
});

test('requestPasswordReset: gera código, apaga anteriores e envia e-mail', async () => {
  let createdCodeHash = null;
  const m = mockAll({
    dbUser: user(),
    repo: {
      create: async ({ userId, codeHash, expiresAt }) => {
        createdCodeHash = codeHash;
        assert.ok(expiresAt instanceof Date);
        return { id: 'code-1' };
      },
    },
  });
  try {
    const out = await passwordResetService.requestPasswordReset({ email: 'fulano@example.com', req });
    assert.equal(out.ok, true);
    assert.equal(out.sent, true);
    assert.equal(m.send.mock.callCount(), 1);
    const call = m.send.mock.calls[0].arguments;
    assert.equal(call[0], 'fulano@example.com');
    assert.match(call[1], /^\d{6}$/);                     // código puro passado ao e-mail
    assert.notEqual(createdCodeHash, call[1]);            // NO BANCO: apenas hash
    assert.equal(createdCodeHash, hashCode(call[1]));     // hash corresponde ao enviado
    // Apagou pedidos anteriores do mesmo usuário
    assert.equal(passwordResetCodeRepository.deleteUnusedForUser.mock.callCount(), 1);
  } finally {
    restoreAll(m);
  }
});

test('requestPasswordReset: falha de envio SMTP segue genérica e contabiliza métrica', async () => {
  const m = mockAll({ dbUser: user(), repo: {}, sendFails: true });
  try {
    const before = metrics.snapshot().counters.passwordResetSmtpFailures;
    const out = await passwordResetService.requestPasswordReset({ email: 'fulano@example.com', req });
    assert.equal(out.ok, true);
    assert.equal(out.sent, false); // neutra: mesma de "não existe"
    assert.equal(metrics.snapshot().counters.passwordResetSmtpFailures, before + 1);
  } finally {
    restoreAll(m);
  }
});

// ── resetPassword ─────────────────────────────────────────────

const active = (over = {}) => ({
  id: 'code-1',
  userId: 'usr-1',
  codeHash: hashCode('123456'),
  expiresAt: new Date(Date.now() + 100000),
  attempts: 0,
  usedAt: null,
  ...over,
});

test('resetPassword: sucesso consome código + redefine senha + bump sessionVersion', async () => {
  const m = mockAll({
    dbUser: user(),
    repo: {
      findActiveForUser: async () => active(),
      consumeAndSetPassword: async ({ codeId, userId, passwordHash }) => {
        assert.equal(codeId, 'code-1');
        assert.equal(userId, 'usr-1');
        assert.equal(passwordHash, 'HASHED_SENHA'); // via bcrypt mock
        return { consumed: 1, user: { ...user(), sessionVersion: 4 } };
      },
    },
  });
  try {
    const out = await passwordResetService.resetPassword({ email: 'fulano@example.com', code: '123456', newPassword: 'NovaSenha1!', req });
    assert.equal(out.ok, true);
    assert.equal(m.audit.mock.callCount() >= 1, true);
    const actions = m.audit.mock.calls.map(c => c.arguments[0].action);
    assert.ok(actions.includes('PASSWORD_RESET_COMPLETED'));
    assert.ok(actions.includes('PASSWORD_RESET_CODE_VERIFIED'));
  } finally {
    restoreAll(m);
  }
});

test('resetPassword: código errado incrementa tentativas e falha (mensagem genérica)', async () => {
  const m = mockAll({
    dbUser: user(),
    repo: {
      findActiveForUser: async () => active(),
      incrementAttemptIfAllowed: async () => ({ id: 'code-1', attempts: 1 }),
    },
  });
  try {
    await assert.rejects(
      () => passwordResetService.resetPassword({ email: 'fulano@example.com', code: '000000', newPassword: 'NovaSenha1!', req }),
      (err) => err instanceof PasswordResetError
    );
    assert.equal(passwordResetCodeRepository.incrementAttemptIfAllowed.mock.callCount(), 1);
  } finally {
    restoreAll(m);
  }
});

test('resetPassword: código expirado invalida e falha genericamente', async () => {
  const invalidation = { count: 0 };
  const m = mockAll({
    dbUser: user(),
    repo: {
      findActiveForUser: async () => active({ expiresAt: new Date(Date.now() - 5000) }),
      invalidate: async (id) => { invalidation.count++; return { count: 1 }; },
    },
  });
  try {
    await assert.rejects(
      () => passwordResetService.resetPassword({ email: 'fulano@example.com', code: '123456', newPassword: 'NovaSenha1!', req })
    );
    assert.equal(invalidation.count, 1);
    const actions = m.audit.mock.calls.map(c => c.arguments[0].action);
    assert.ok(actions.includes('PASSWORD_RESET_CODE_EXPIRED'));
  } finally {
    restoreAll(m);
  }
});

test('resetPassword: teto de tentativas (5) invalida o código', async () => {
  const m = mockAll({
    dbUser: user(),
    repo: {
      findActiveForUser: async () => active({ attempts: 5 }),
    },
  });
  try {
    await assert.rejects(
      () => passwordResetService.resetPassword({ email: 'fulano@example.com', code: '123456', newPassword: 'NovaSenha1!', req })
    );
    // with attempts>=5 não vai nem incrementar — invalida direto
    assert.equal(passwordResetCodeRepository.incrementAttemptIfAllowed.mock.callCount(), 0);
    assert.equal(passwordResetCodeRepository.invalidate.mock.callCount(), 1);
    const actions = m.audit.mock.calls.map(c => c.arguments[0].action);
    assert.ok(actions.includes('PASSWORD_RESET_ATTEMPTS_EXCEEDED'));
  } finally {
    restoreAll(m);
  }
});

test('resetPassword: consumo concorrente (count-0) falha sem sobrescrever', async () => {
  const m = mockAll({
    dbUser: user(),
    repo: {
      findActiveForUser: async () => active(),
      consumeAndSetPassword: async () => ({ consumed: 0, user: null }),
    },
  });
  try {
    await assert.rejects(
      () => passwordResetService.resetPassword({ email: 'fulano@example.com', code: '123456', newPassword: 'NovaSenha1!', req }),
      (err) => err instanceof PasswordResetError
    );
  } finally {
    restoreAll(m);
  }
});

test('resetPassword: e-mail inexistente retorna erro genérico (não enumera)', async () => {
  const m = mockAll({ dbUser: null, repo: {} });
  try {
    await assert.rejects(
      () => passwordResetService.resetPassword({ email: 'ghost@x.com', code: '123456', newPassword: 'NovaSenha1!', req }),
      (err) => err instanceof PasswordResetError && /inválido ou expirado/.test(err.message)
    );
    assert.equal(passwordResetCodeRepository.findActiveForUser.mock.callCount(), 0);
  } finally {
    restoreAll(m);
  }
});

test('resetPassword: senha fraca falha antes de consultar usuário/código (antienumeração)', async () => {
  const m = mockAll({ dbUser: user(), repo: {} });
  try {
    await assert.rejects(
      () => passwordResetService.resetPassword({ email: 'fulano@example.com', code: '123456', newPassword: 'ab', req }),
      (err) => err instanceof PasswordResetError
    );
    assert.equal(m.userFind.mock.callCount(), 0, 'não consulta DB com senha já inválida');
    assert.equal(passwordResetCodeRepository.consumeAndSetPassword.mock.callCount(), 0);
    assert.equal(m.hash.mock.callCount(), 0);
  } finally {
    restoreAll(m);
  }
});

test('requestPasswordReset: pedidos anteriores invalidadas geram auditoria PASSWORD_RESET_CODE_INVALIDATED', async () => {
  const m = mockAll({
    dbUser: user(),
    repo: {
      deleteUnusedForUser: async () => ({ count: 2 }),
    },
  });
  try {
    await passwordResetService.requestPasswordReset({ email: 'fulano@example.com', req });
    const actions = m.audit.mock.calls.map(c => c.arguments[0].action);
    assert.ok(actions.includes('PASSWORD_RESET_CODE_INVALIDATED'));
    const metaCall = m.audit.mock.calls.find(c => c.arguments[0].action === 'PASSWORD_RESET_CODE_INVALIDATED');
    assert.equal(metaCall.arguments[0].meta.count, 2);
  } finally {
    restoreAll(m);
  }
});