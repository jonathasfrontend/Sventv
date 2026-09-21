'use strict';

/**
 * Regressão do loop de recarga /dashboard↔/login + estouro de rate limit
 * (docs/RELATORIO-CORRECAO-LOOP-DASHBOARD-RATE-LIMIT-2026-09-19.md e
 * docs/RELATORIO-CORRECAO-LOOP-DASHBOARD-2026-09-19-v2.md).
 *
 * Guarda as ISENÇÕES do bucket global (assets estáticos e bootstrap de
 * credencial) e o comportamento de resolveUser com contas pendentes —
 * qualquer regressão aqui reabre o loop: bucket global esgotado → 429 no
 * /api/auth/api-token → API token '' → 401 no /api/channels → /login → loop.
 */

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const jwt = require('jsonwebtoken');
const config = require('../src/config/app');
const User = require('../src/models/User');
const { resolveUser, requireWebAuth } = require('../src/middlewares/webAuth');
const {
  isStaticAssetPath,
  isAuthTokenPath,
  isProxyPath,
  isGlobalExempt,
} = require('../src/middlewares/rateLimiter');

// ─────────────────────────────────────────────────────────────
// Isenções do bucket global
// ─────────────────────────────────────────────────────────────

test('isStaticAssetPath: assets de página NÃO consomem cota global', () => {
  for (const p of [
    '/js/dashboard.js',
    '/js/guia.js',
    '/css/base.css',
    '/img/logo.svg',
    '/favicon.ico',
    '/Player/index.html',
    '/Player/player.js',
    '/manifest.webmanifest',
    '/font.woff2',
  ]) {
    assert.equal(isStaticAssetPath({ path: p, originalUrl: p }), true, p);
  }

  for (const p of [
    '/dashboard',
    '/guia',
    '/login',
    '/api/channels',
    '/api/dashboard',
    '/api/health',
  ]) {
    assert.equal(isStaticAssetPath({ path: p, originalUrl: p }), false, p);
  }
});

test('isAuthTokenPath: GET /api/auth/api-token é isento do bucket global', () => {
  assert.equal(
    isAuthTokenPath({ path: '/api/auth/api-token', originalUrl: '/api/auth/api-token', method: 'GET' }),
    true
  );
  // Só a forma EXATA é isenta — as demais rotas de auth continuam cobertas.
  assert.equal(isAuthTokenPath({ path: '/api/auth/api-token', originalUrl: '/api/auth/api-token', method: 'POST' }), false);
  assert.equal(isAuthTokenPath({ path: '/api/auth/login', originalUrl: '/api/auth/login', method: 'GET' }), false);
  assert.equal(isAuthTokenPath({ path: '/api/auth/register', originalUrl: '/api/auth/register', method: 'GET' }), false);
  assert.equal(isAuthTokenPath({ path: '/api/auth/api-token?x=1', originalUrl: '/api/auth/api-token?x=1', method: 'GET' }), true, 'query string não quebra o match');
});

test('isGlobalExempt: isenções combinam sem excluir rotas REST', () => {
  assert.equal(isGlobalExempt({ path: '/js/app.js', method: 'GET' }), true);
  assert.equal(isGlobalExempt({ path: '/api/auth/api-token', method: 'GET' }), true);
  assert.equal(isGlobalExempt({ path: '/api/channels/abc/proxy', method: 'GET' }), true);
  assert.equal(isGlobalExempt({ path: '/api/channels', method: 'GET' }), false);
  assert.equal(isGlobalExempt({ path: '/dashboard', method: 'GET' }), false);
  assert.equal(isGlobalExempt({ path: '/api/auth/login', method: 'POST' }), false);
});

test('isProxyPath: só o sub-recuso de proxy HLS', () => {
  assert.equal(isProxyPath({ path: '/api/channels/abc/proxy', originalUrl: '/api/channels/abc/proxy' }), true);
  assert.equal(isProxyPath({ path: '/api/channels/abc/stream', originalUrl: '/api/channels/abc/stream' }), false);
  assert.equal(isProxyPath({ path: '/api/channels', originalUrl: '/api/channels' }), false);
});

// ─────────────────────────────────────────────────────────────
// resolveUser: contas não-ativas são anônimas no SSR (sem loop)
// ─────────────────────────────────────────────────────────────

function signSession(id, sv) {
  return jwt.sign({ id, sv }, config.jwt.secret, { expiresIn: '1h' });
}

function makeReq(token) {
  return { cookies: { sessionToken: token }, headers: {}, originalUrl: '/dashboard' };
}

function makeRes() {
  const res = { locals: {}, redirectedTo: null };
  return {
    res,
    resStub: {
      locals: res.locals,
      redirect(to) { res.redirectedTo = to; },
    },
  };
}

const originalFindById = User.findById;

afterEach(() => {
  User.findById = originalFindById;
});

test('resolveUser: status active + sv ok → usuário resolvido', async () => {
  const original = User.findById;
  User.findById = async (id) => ({ _id: id, status: 'active', role: 'user', sessionVersion: 0 });

  try {
    const { res, resStub } = makeRes();
    const req = makeReq(signSession('u-1', 0));
    let nexted = false;
    await resolveUser(req, resStub, () => { nexted = true; });
    assert.equal(nexted, true);
    assert.equal(req.user._id, 'u-1');
    assert.equal(res.locals.user._id, 'u-1');
    assert.equal(res.redirectedTo, null);
  } finally {
    User.findById = original;
  }
});

test('resolveUser: pending/inactive/banned são anônimos (sem loop SSR)', async () => {
  const original = User.findById;
  for (const status of ['pending', 'inactive', 'banned']) {
    User.findById = async (id) => ({ _id: id, status, role: 'user', sessionVersion: 0 });

    const req = makeReq(signSession('u-1', 0));
    const { resStub } = makeRes();
    let nexted = false;
    await resolveUser(req, resStub, () => { nexted = true; });

    assert.equal(nexted, true, `${status}: next deve ser chamado`);
    assert.equal(req.user, null, `${status}: deve ficar anônimo`);
  }
  User.findById = original;
});

test('requireWebAuth: conta pending vai para /login (uma vez, sem redeploy)', async () => {
  const original = User.findById;
  User.findById = async (id) => ({ _id: id, status: 'pending', role: 'user', sessionVersion: 0 });

  try {
    const { res, resStub } = makeRes();
    const req = makeReq(signSession('u-1', 0));
    await requireWebAuth(req, resStub, () => { throw new Error('não pode passar para a página'); });
    assert.equal(res.redirectedTo, '/login?returnTo=%2Fdashboard');
  } finally {
    User.findById = original;
  }
});

test('resolveUser: sessionVersion defasada (logout/revogada) → anônimo', async () => {
  const original = User.findById;
  User.findById = async (id) => ({ _id: id, status: 'active', role: 'user', sessionVersion: 3 });

  try {
    const req = makeReq(signSession('u-1', 0));
    const { resStub } = makeRes();
    let nexted = false;
    await resolveUser(req, resStub, () => { nexted = true; });
    assert.equal(nexted, true);
    assert.equal(req.user, null);
  } finally {
    User.findById = original;
  }
});