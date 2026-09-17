'use strict';

const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const config = require('../src/config/app');
const User = require('../src/models/User');
const { validateSessionToken } = require('../src/middlewares/auth');

function sign(payload, expiresIn = '1h') {
  return jwt.sign(payload, config.jwt.secret, { expiresIn });
}

test('token válido com sv correto aceita', async () => {
  mock.method(User, 'findById', async () => ({
    _id: 'u1',
    id: 'u1',
    email: 'a@a.com',
    sessionVersion: 4,
    status: 'active',
    role: 'user',
  }));
  try {
    const token = sign({ id: 'u1', sv: 4 });
    const { user, error } = await validateSessionToken(token);
    assert.ok(!error, 'sem erro de autenticação');
    assert.equal(user.id, 'u1');
  } finally {
    User.findById.mock.restore();
  }
});

test('token com sv defasado é revogado (401 sessão revogada)', async () => {
  mock.method(User, 'findById', async () => ({
    id: 'u1',
    email: 'a@a.com',
    sessionVersion: 5, // bump: senha trocada / logout em outro dispositivo
    status: 'active',
    role: 'user',
  }));
  try {
    const token = sign({ id: 'u1', sv: 4 });
    const { user, error } = await validateSessionToken(token);
    assert.ok(!user);
    assert.equal(error.status, 401);
    assert.match(error.message, /revogada/);
  } finally {
    User.findById.mock.restore();
  }
});

test('token sem claim sv (legado) ainda funciona se não houver bump', async () => {
  mock.method(User, 'findById', async () => ({
    id: 'u1',
    email: 'a@a.com',
    sessionVersion: 0,
    status: 'active',
    role: 'user',
  }));
  try {
    const token = sign({ id: 'u1' });
    const { user, error } = await validateSessionToken(token);
    assert.ok(!error);
    assert.equal(user.id, 'u1');
  } finally {
    User.findById.mock.restore();
  }
});

test('reset de senha incrementa sessionVersion → tokens antigos morrem (integração serviço)', async () => {
  // Simula o contrato do repositório usado no reset: bump + hash.
  const fakeRepo = require('../src/repositories/passwordResetCodeRepository');

  let bumpedUser = { id: 'u1', email: 'a@a.com', sessionVersion: 0, status: 'active', role: 'user' };

  mock.method(User, 'findById', async () => bumpedUser);
  mock.method(fakeRepo, 'consumeAndSetPassword', async () => {
    bumpedUser = { ...bumpedUser, sessionVersion: bumpedUser.sessionVersion + 1 };
    return { consumed: 1, user: bumpedUser };
  });
  try {
    const before = sign({ id: 'u1', sv: 0 });       // emitido antes do reset
    const { user, error: errA } = await validateSessionToken(before);
    assert.ok(!errA);

    // "Reset" consome e bumpeia a versão.
    const { consumed } = await fakeRepo.consumeAndSetPassword({ codeId: 'c', userId: 'u1', passwordHash: 'x' });
    assert.equal(consumed, 1);

    // O mesmo token agora é rejeitado.
    const { user: u2, error } = await validateSessionToken(before);
    assert.ok(!u2);
    assert.equal(error.status, 401);
  } finally {
    User.findById.mock.restore();
    fakeRepo.consumeAndSetPassword.mock.restore();
  }
});