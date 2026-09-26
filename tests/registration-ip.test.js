'use strict';

/**
 * Captura do IP real no cadastro (feature WAF / IP Access Control):
 *  - User.create persiste `registrationIp` no payload (fonte: banco);
 *  - authService.register repassa o `registrationIp` recebido (e null quando
 *    ausente);
 *  - registerWithGoogle (Google OAuth) injeta o IP na conta criada;
 *  - authController.register coleta o IP no SERVIDOR via getClientIp(req)
 *    (nunca aceita do frontend) e repassa ao serviço.
 *
 * Técnica: dbState stubbed via require.cache antes do import do authService
 * (ele destrutura isDatabaseConnected no load); User/userRepository com
 * atributos substituídos e restaurados em finally; alertService com sinks
 * fake (nunca toca webhook/e-mail reais).
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
});

// dbState: simula banco conectado (authService destrutura no load do módulo).
const DB_STATE_PATH = require.resolve('../src/utils/dbState');
const savedDbState = require.cache[DB_STATE_PATH];
require.cache[DB_STATE_PATH] = {
  id: DB_STATE_PATH,
  filename: DB_STATE_PATH,
  loaded: true,
  exports: {
    isDatabaseConnected: () => true,
    createDatabaseUnavailableError: (msg) => {
      const e = new Error(msg);
      e.statusCode = 503;
      return e;
    },
  },
};

const User = require('../src/models/User');
// userRepository EXPORTA { userRepository, normalizeEmail } — o objeto que o
// User.js destruturou é o interno `exports.userRepository`, não o wrapper.
const userRepoModule = require('../src/repositories/userRepository');
const userRepository = userRepoModule.userRepository;
const authService = require('../src/services/authService');
const authController = require('../src/controllers/authController');
const googleAuthService = require('../src/services/googleAuthService');

after(() => {
  if (savedDbState) require.cache[DB_STATE_PATH] = savedDbState;
  else delete require.cache[DB_STATE_PATH];
});

// ── User.create persiste registrationIp ──────────────────────

test('User.create: persiste registrationIp no payload (write ao banco)', async () => {
  const saved = {
    create: userRepository.create,
    findRoleByCode: userRepository.findRoleByCode,
    updateById: userRepository.updateById,
  };
  let captured = null;
  let createdRow = null;
  userRepository.findRoleByCode = async () => ({ id: 'role-user' });
  userRepository.create = async (payload) => {
    captured = payload;
    createdRow = { ...payload, id: 'u-1', createdAt: new Date('2026-09-01T00:00:00Z') };
    return createdRow;
  };
  userRepository.updateById = async (id, data) => ({ ...createdRow, ...data });

  try {
    const user = await User.create({
      name: 'Ana',
      email: 'ana@example.com',
      password: 'SenhaForte123',
      registrationIp: '203.0.113.7',
    });
    assert.equal(captured.registrationIp, '203.0.113.7', 'payload enviado ao banco deve conter o IP');
    assert.equal(user.registrationIp, '203.0.113.7', 'modelo deve expor registrationIp');
    const json = user.toJSON();
    assert.equal(json.registrationIp, '203.0.113.7');
    assert.equal('password' in json, false, 'toJSON nunca expõe senha');
  } finally {
    Object.assign(userRepository, saved);
  }
});

test('User.create: sem registrationIp → null (nunca inventa IP)', async () => {
  const saved = {
    create: userRepository.create,
    findRoleByCode: userRepository.findRoleByCode,
    updateById: userRepository.updateById,
  };
  let captured = null;
  userRepository.findRoleByCode = async () => ({ id: 'role-user' });
  userRepository.create = async (payload) => {
    captured = payload;
    return { ...payload, id: 'u-2', createdAt: new Date() };
  };
  userRepository.updateById = async (id, data) => ({ id, ...data });

  try {
    await User.create({ name: 'Bob', email: 'bob@example.com', password: 'SenhaForte123' });
    assert.equal(captured.registrationIp, null);
  } finally {
    Object.assign(userRepository, saved);
  }
});

// ── authService.register repassa registrationIp ──────────────

function fakeModelForRegister() {
  return {
    _id: 'u-1',
    id: 'u-1',
    name: 'Ana',
    email: 'ana@example.com',
    createdAt: new Date(),
    toJSON: () => ({ id: 'u-1', email: 'ana@example.com', name: 'Ana', registrationIp: null }),
    generateSessionToken: () => 'sess-token',
  };
}

test('authService.register: encaminha registrationIp ao User.create', async () => {
  const saved = {
    findOne: User.findOne,
    create: User.create,
    findByIdWithSensitive: User.findByIdWithSensitive,
  };
  let createArgs = null;
  User.findOne = async () => null;
  User.create = async (args) => { createArgs = args; return fakeModelForRegister(); };
  User.findByIdWithSensitive = async () => ({ apiToken: 'api-token' });

  try {
    const r = await authService.register({
      name: 'Ana',
      email: 'ana@example.com',
      password: 'SenhaForte123',
      confirmPassword: 'SenhaForte123',
      acceptedTerms: true,
      registrationIp: '203.0.113.7',
    });
    assert.equal(createArgs.registrationIp, '203.0.113.7');
    assert.equal(r.apiToken, 'api-token');
    assert.equal(r.sessionToken, 'sess-token');
  } finally {
    Object.assign(User, saved);
  }
});

test('authService.register: sem registrationIp → null (charged para usuários novos)', async () => {
  const saved = {
    findOne: User.findOne,
    create: User.create,
    findByIdWithSensitive: User.findByIdWithSensitive,
  };
  let createArgs = null;
  User.findOne = async () => null;
  User.create = async (args) => { createArgs = args; return fakeModelForRegister(); };
  User.findByIdWithSensitive = async () => ({ apiToken: 'api-token' });

  try {
    await authService.register({
      name: 'Bob',
      email: 'bob@example.com',
      password: 'SenhaForte123',
      confirmPassword: 'SenhaForte123',
      acceptedTerms: true,
    });
    assert.equal(createArgs.registrationIp, null);
  } finally {
    Object.assign(User, saved);
  }
});

// ── registerWithGoogle injeta o IP na conta Google ───────────

test('registerWithGoogle: repassa options.registrationIp ao User.create', async () => {
  const saved = {
    findByGoogleId: User.findByGoogleId,
    findByEmail: User.findByEmail,
    create: User.create,
  };
  let createArgs = null;
  User.findByGoogleId = async () => null;
  User.findByEmail = async () => null;
  User.create = async (args) => {
    createArgs = args;
    return { _id: 'g-1', name: 'Ana G', email: 'ana.g@gmail.com', createdAt: new Date() };
  };

  try {
    await googleAuthService.registerWithGoogle(
      { googleId: 'g123', email: 'ana.g@gmail.com', verifiedEmail: true, name: 'Ana G', picture: 'https://p.example/x.png' },
      { registrationIp: '203.0.113.7' }
    );
    assert.equal(createArgs.registrationIp, '203.0.113.7');
    assert.equal(createArgs.googleId, 'g123', 'conta criada já nasce com googleId');
  } finally {
    Object.assign(User, saved);
  }
});

// ── authController.register coleta IP no servidor ────────────

test('authController.register: IP é coletado via getClientIp(req) e repassado', async () => {
  const prisma = require('../src/prisma/client');
  const savedRegister = authService.register;
  const savedAudit = prisma.auditLog.create;
  let svcArgs = null;
  authService.register = async (data) => {
    svcArgs = data;
    return { sessionToken: 'sess-x', apiToken: 'api-x', user: { id: 'u-1', email: 'ana@example.com' } };
  };
  prisma.auditLog.create = async () => ({});

  const res = {
    statusCode: null,
    jsonBody: null,
    cookies: {},
    status(c) { this.statusCode = c; return this; },
    cookie(k, v) { this.cookies[k] = v; return this; },
    json(b) { this.jsonBody = b; return this; },
  };

  try {
    const req = {
      ip: '::ffff:203.0.113.8',
      body: {
        name: 'Ana',
        email: 'ana@example.com',
        password: 'SenhaForte123',
        confirmPassword: 'SenhaForte123',
        acceptedTerms: true,
      },
    };
    await authController.register(req, res, () => {});
    await new Promise((r) => setTimeout(r, 10)); // libera audit fire-and-forget antes de restaurar
    assert.equal(svcArgs.registrationIp, '203.0.113.8', 'IPv4-mapped deve virar IPv4 canônico');
    assert.equal(res.statusCode, 201);
    assert.equal(res.cookies.sessionToken, 'sess-x');
  } finally {
    authService.register = savedRegister;
    prisma.auditLog.create = savedAudit;
  }
});