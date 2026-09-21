'use strict';

/**
 * GET /api/auth/api-token — regressão do loop de login:
 * a resposta NUNCA pode ser cacheada pelo navegador (um 304 serviria um
 * token antigo, o que faz as chamadas seguintes levarem 401 e a página
 * voltar ao /login em loop, estourando o rate limit).
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const SERVICE_PATH = require.resolve('../src/services/authService');
let serviceImpl = null;
require.cache[SERVICE_PATH] = {
  id: SERVICE_PATH,
  filename: SERVICE_PATH,
  loaded: true,
  exports: new Proxy({}, {
    get(_t, prop) {
      return async (...args) => {
        if (!serviceImpl || typeof serviceImpl[prop] !== 'function') {
          const e = new Error(`${prop} não stubbed`);
          e.statusCode = 500;
          throw e;
        }
        return serviceImpl[prop](...args);
      };
    },
  }),
};

const authController = require('../src/controllers/authController');

beforeEach(() => { serviceImpl = null; });

function makeRes() {
  return {
    statusCode: 0,
    sent: null,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.sent = payload; return this; },
  };
}

test('revealApiToken: 200 + Cache-Control no-store (nunca servir token antigo)', async () => {
  serviceImpl = { getProfile: async () => ({ apiToken: 'tok_123' }) };
  const req = { user: { _id: 'u-1' } };
  const res = makeRes();

  await authController.revealApiToken(req, res, () => {});

  assert.equal(res.statusCode, 200);
  assert.equal(res.sent.data.apiToken, 'tok_123');
  assert.equal(res.headers['Cache-Control'], 'no-store');
});

test('requireSessionOrApi: Bearer inválido cai para o cookie de sessão (sem 401/loop)', async () => {
  const jwt = require('jsonwebtoken');
  const config = require('../src/config/app');
  const User = require('../src/models/User');
  const { setDatabaseConnected } = require('../src/utils/dbState');
  const { requireSessionOrApi } = require('../src/middlewares/auth');

  setDatabaseConnected(true);
  const originalFindById = User.findById;
  User.findById = async (id) => ({ _id: id, status: 'active', sessionVersion: 0 });

  try {
    const sessionToken = jwt.sign({ id: 'u-1', sv: 0 }, config.jwt.secret, { expiresIn: '1h' });
    const req = {
      cookies: { sessionToken },
      headers: { authorization: 'Bearer token-de-api-desatualizado' },
      query: {},
    };
    let nextCalled = false;
    const res = { status() { return this; }, json() { return this; } };

    await requireSessionOrApi(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, true);
    assert.equal(req.authKind, 'session');
    assert.equal(req.user._id, 'u-1');
  } finally {
    User.findById = originalFindById;
  }
});
