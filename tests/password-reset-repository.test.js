'use strict';

/**
 * Contrato do consumo atômico de código de redefinição de senha.
 *
 * `consumeAndSetPassword` deve garantir uso único em UMA instrução SQL
 * (CTE data-modifying), sem transação multi-statement, com os guards
 * `used_at IS NULL`, `attempts < max` e `expires_at > now` no próprio UPDATE.
 * Provado aqui pela forma do SQL e pelo handshake count-0/count-1.
 *
 * Obs.: o cliente Prisma é Proxy-based, o que quebra `mock.method` do
 * node:test — aqui usamos substituição manual com restauração em finally.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const prisma = require('../src/prisma/client');
const passwordResetCodeRepository = require('../src/repositories/passwordResetCodeRepository');

function asSql(tpl) {
  const strings = Array.isArray(tpl) ? tpl : [tpl];
  const raw = strings.raw ? strings.raw.join('?') : strings.join('?');
  return String(raw);
}

async function withRaw(execImpl, findImpl, fn) {
  const origExec = prisma.$executeRaw;
  const origFind = prisma.user?.findUnique;
  prisma.$executeRaw = execImpl;
  if (origFind !== undefined) prisma.user.findUnique = findImpl;
  try {
    await fn();
  } finally {
    prisma.$executeRaw = origExec;
    if (origFind !== undefined) prisma.user.findUnique = origFind;
  }
}

test('consumeAndSetPassword: count-0 (concorrência/expirado/teto) → consumed 0 e nunca toca o usuário', async () => {
  await withRaw(
    async () => 0,
    async () => ({}),
    async () => {
      const out = await passwordResetCodeRepository.consumeAndSetPassword({
        codeId: 'code-1',
        userId: 'usr-1',
        passwordHash: 'HASH',
        maxAttempts: 5,
      });
      assert.deepEqual(out, { consumed: 0, user: null });
    }
  );
});

test('consumeAndSetPassword: count-1 → consumed 1 e devolve usuário com sessionVersion nova', async () => {
  let findCalled = 0;
  let findQuery = null;
  await withRaw(
    async () => 1,
    async (query) => {
      findCalled += 1;
      findQuery = query;
      return { id: 'usr-1', sessionVersion: 4 };
    },
    async () => {
      const out = await passwordResetCodeRepository.consumeAndSetPassword({
        codeId: 'code-1',
        userId: 'usr-1',
        passwordHash: 'HASH',
        maxAttempts: 5,
      });
      assert.equal(out.consumed, 1);
      assert.equal(out.user.sessionVersion, 4);
      assert.equal(findCalled, 1);
      assert.deepEqual(findQuery, { where: { id: 'usr-1' }, select: { id: true, sessionVersion: true } });
    }
  );
});

test('consumeAndSetPassword: count-0 não consulta findUnique do usuário', async () => {
  let findCalled = 0;
  await withRaw(
    async () => 0,
    async () => { findCalled += 1; return {}; },
    async () => {
      await passwordResetCodeRepository.consumeAndSetPassword({
        codeId: 'code-1',
        userId: 'usr-1',
        passwordHash: 'HASH',
        maxAttempts: 5,
      });
      assert.equal(findCalled, 0);
    }
  );
});

test('consumeAndSetPassword: SQL traz todos os guards atômicos em statement único', async () => {
  let sql = '';
  await withRaw(
    async (tpl) => { sql = asSql(tpl); return 1; },
    async () => ({ id: 'usr-1', sessionVersion: 4 }),
    async () => {
      await passwordResetCodeRepository.consumeAndSetPassword({
        codeId: 'code-1',
        userId: 'usr-1',
        passwordHash: 'HASH',
        maxAttempts: 5,
      });
      assert.match(sql, /UPDATE "password_reset_codes"/);
      assert.match(sql, /"used_at" IS NULL/);
      assert.match(sql, /"attempts" < \?/);
      assert.match(sql, /"expires_at" > /);
      assert.match(sql, /UPDATE "users"/);
      assert.match(sql, /"session_version" = "users"\."session_version" \+ 1/);
      // Atomicidade por instrução única: nada de BEGIN/START TRANSACTION.
      assert.ok(!/BEGIN|START TRANSACTION/.test(sql));
    }
  );
});

test('consumeAndSetPassword: maxAttempts omisso usa o padrão 5', async () => {
  let attemptLimit = null;
  await withRaw(
    async (tpl, ...values) => { attemptLimit = values[2]; return 1; },
    async () => ({ id: 'usr-1', sessionVersion: 4 }),
    async () => {
      await passwordResetCodeRepository.consumeAndSetPassword({ codeId: 'code-1', userId: 'usr-1', passwordHash: 'HASH' });
      assert.equal(attemptLimit, 5);
    }
  );
});