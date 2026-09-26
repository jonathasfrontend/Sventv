'use strict';

/**
 * Middleware de IP Access Control (src/middlewares/ipAccess.js):
 *  - IP bloqueado → 403 (JSON em /api, HTML mínimo em páginas);
 *  - assets estáticos, /favicon.ico e /api/health seguem acessíveis;
 *  - fail-open: erro do gate nunca derruba o request;
 *  - IP ausente/indefinido não bloqueia.
 *
 * O middleware usa IpBlocklistService.getShared() — substituímos o módulo via
 * require.cache ANTES do import (padrão já usado em admin-users-controller).
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const SERVICE_PATH = require.resolve('../src/services/ipBlocklistService');

let blockedSet = new Set();
let throwOnCheck = false;
class FakeIpBlocklistService {
  static _shared = null;
  async isBlocked(ip) {
    if (throwOnCheck) throw new Error('banco fora');
    return blockedSet.has(ip);
  }
  async ensureLoaded() { return 0; }
  peek() { return false; }
  block() {}
  unblock() {}
  all() { return []; }
  restore() { return this; }
}
FakeIpBlocklistService.getShared = () => {
  if (!FakeIpBlocklistService._shared) FakeIpBlocklistService._shared = new FakeIpBlocklistService();
  return FakeIpBlocklistService._shared;
};

const savedModule = require.cache[SERVICE_PATH];
require.cache[SERVICE_PATH] = {
  id: SERVICE_PATH,
  filename: SERVICE_PATH,
  loaded: true,
  exports: FakeIpBlocklistService,
};

const { ipAccess, isSkippable } = require('../src/middlewares/ipAccess');

after(() => {
  if (savedModule) require.cache[SERVICE_PATH] = savedModule;
  else delete require.cache[SERVICE_PATH];
});

function nextWrapper() {
  let calledNext = false;
  const next = () => { calledNext = true; };
  return { next, getCalled: () => calledNext };
}

function spyRes() {
  const res = {
    statusCode: null, body: null, headers: {}, jsonBody: null, sent: false,
  };
  res.status = function (code) { this.statusCode = code; return this; };
  res.json = function (obj) { this.jsonBody = obj; this.sent = true; return this; };
  res.setHeader = function (k, v) { this.headers[k] = v; };
  res.send = function (html) { this.body = html; this.sent = true; return this; };
  return res;
}

before(() => { blockedSet = new Set(); throwOnCheck = false; });

test('isSkippable: assets estáticos, health e favicon são liberados', () => {
  assert.equal(isSkippable({ path: '/api/health', url: '/api/health' }), true);
  assert.equal(isSkippable({ path: '/favicon.ico', url: '/favicon.ico' }), true);
  assert.equal(isSkippable({ path: '/css/admin.css', url: '/css/admin.css' }), true);
  assert.equal(isSkippable({ path: '/js/admin.js', url: '/js/admin.js' }), true);
  assert.equal(isSkippable({ path: '/Player/player.js', url: '/Player/player.js' }), true);
});

test('isSkippable: página e rota API comercial NÃO são liberados', () => {
  assert.equal(isSkippable({ path: '/login', url: '/login' }), false);
  assert.equal(isSkippable({ path: '/api/channels', url: '/api/channels' }), false);
  assert.equal(isSkippable({ path: '/stream', url: '/stream' }), false);
});

test('ipAccess: IP bloqueado em /api → 403 JSON "Acesso negado."', async () => {
  blockedSet.add('203.0.113.50');
  const res = spyRes();
  const { next, getCalled } = nextWrapper();
  await ipAccess({ ip: '203.0.113.50', path: '/api/channels', url: '/api/channels', method: 'GET' }, res, next);
  assert.equal(res.statusCode, 403);
  assert.equal(res.jsonBody.success, false);
  assert.equal(getCalled(), false);
});

test('ipAccess: IP bloqueado em página → 403 HTML mínimo sem detalhes', async () => {
  blockedSet.add('203.0.113.51');
  const res = spyRes();
  const { next, getCalled } = nextWrapper();
  await ipAccess({ ip: '203.0.113.51', path: '/login', url: '/login', method: 'GET' }, res, next);
  assert.equal(res.statusCode, 403);
  assert.match(res.body, /Acesso negado/);
  assert.equal(getCalled(), false);
});

test('ipAccess: IP liberado → next() sem tocar a resposta', async () => {
  const res = spyRes();
  const { next, getCalled } = nextWrapper();
  await ipAccess({ ip: '203.0.113.52', path: '/api/channels', url: '/api/channels', method: 'GET' }, res, next);
  assert.equal(getCalled(), true);
  assert.equal(res.sent, false);
});

test('ipAccess: health e estático continuam acessíveis a IPs bloqueados', async () => {
  blockedSet.add('203.0.113.53');
  const res = spyRes();
  const { next, getCalled } = nextWrapper();
  await ipAccess({ ip: '203.0.113.53', path: '/api/health', url: '/api/health', method: 'GET' }, res, next);
  await ipAccess({ ip: '203.0.113.53', path: '/css/admin.css', url: '/css/admin.css', method: 'GET' }, res, next);
  assert.equal(getCalled(), true);
});

test('ipAccess: IP ausente/indefinido não bloqueia (fail-open no cliente)', async () => {
  const res = spyRes();
  const { next, getCalled } = nextWrapper();
  await ipAccess({ path: '/api/channels', url: '/api/channels', method: 'GET' }, res, next);
  assert.equal(getCalled(), true);
});

test('ipAccess: erro interno do gate → next() (fail-open, nunca 500)', async () => {
  throwOnCheck = true;
  blockedSet.add('203.0.113.54');
  const res = spyRes();
  const { next, getCalled } = nextWrapper();
  await ipAccess({ ip: '203.0.113.54', path: '/api/channels', url: '/api/channels', method: 'GET' }, res, next);
  assert.equal(getCalled(), true);
  assert.equal(res.sent, false);
});