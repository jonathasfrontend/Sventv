'use strict';

/**
 * Avise-me — Controller + rotas:
 *  - POST /api/user/reminders → 201 com shape serializado (nunca objeto
 *    interno "cru"); DELETE/mark 200; list 200;
 *  - erros de negócio (404/409/422) passam por next(error) — nunca viram 500;
 *  - schema Joi: mass-assignment bloqueado (stripUnknown), dates ISO, limites;
 *  - rotas protegidas: /api/user/reminders sem token → 401.
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { setDatabaseConnected } = require('../src/utils/dbState');

const SERVICE_PATH = require.resolve('../src/services/reminderService');
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

const reminderController = require('../src/controllers/reminderController');

beforeEach(() => { serviceImpl = null; });

function makeRes() {
  const res = {
    statusCode: 0,
    sent: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.sent = payload; return this; },
  };
  return res;
}

const REMINDER = {
  id: 'r-1',
  channelId: 'ch-1',
  title: 'Jornal Hoje',
  startsAt: new Date('2026-09-20T20:00:00.000Z'),
  stopAt: new Date('2026-09-20T21:00:00.000Z'),
  notifiedAt: null,
  createdAt: new Date('2026-09-18T12:00:00.000Z'),
};

// ── Controller ────────────────────────────────────────────────

test('create: 201 + shape serializado (ISO, sem campos internos)', async () => {
  serviceImpl = { createReminder: async () => REMINDER };
  const req = { user: { id: 'u-1' }, body: { channelId: 'ch-1', title: 'Jornal Hoje', startsAt: REMINDER.startsAt.toISOString() } };
  const res = makeRes();
  await reminderController.create(req, res, () => {});
  assert.equal(res.statusCode, 201);
  assert.equal(res.sent.success, true);
  assert.equal(res.sent.data.startsAt, '2026-09-20T20:00:00.000Z');
  assert.ok(!('createdAt' in res.sent.data && res.sent.data.createdAt instanceof Date), 'datas são strings ISO');
  assert.equal(typeof res.sent.data.id, 'string');
});

test('create: erro de negócio (409 duplicado) propaga por next — nunca 500', async () => {
  const err = Object.assign(new Error('Você já criou um lembrete para este programa.'), { statusCode: 409, code: 'DUPLICATE' });
  serviceImpl = { createReminder: async () => { throw err; } };
  let captured = null;
  const req = { user: { id: 'u-1' }, body: {} };
  await reminderController.create(req, makeRes(), (e) => { captured = e; });
  assert.equal(captured, err);
});

test('list: 200 com array serializado', async () => {
  serviceImpl = { listReminders: async () => [REMINDER] };
  const req = { user: { id: 'u-1' }, query: {}, };
  const res = makeRes();
  await reminderController.list(req, res, () => {});
  assert.equal(res.statusCode, 200);
  assert.equal(res.sent.data.length, 1);
  assert.equal(res.sent.data[0].title, 'Jornal Hoje');
});

test('remove: 200 e owner vem só de req.user.id (ignora body/URL)', async () => {
  let userIdSeen = null;
  serviceImpl = {
    deleteReminder: async (userId, id) => { userIdSeen = userId; assert.equal(id, 'r-1'); return true; },
  };
  const req = { user: { id: 'u-1' }, params: { id: 'r-1' } };
  const res = makeRes();
  await reminderController.remove(req, res, () => {});
  assert.equal(res.statusCode, 200);
  assert.equal(userIdSeen, 'u-1');
});

test('markNotified: 200; 404 do service propaga por next', async () => {
  serviceImpl = { markNotified: async () => true };
  const req = { user: { id: 'u-1' }, params: { id: 'r-1' } };
  const res = makeRes();
  await reminderController.markNotified(req, res, () => {});
  assert.equal(res.statusCode, 200);

  serviceImpl = {
    markNotified: async () => { throw Object.assign(new Error('Lembrete não encontrado.'), { statusCode: 404 }); },
  };
  let captured = null;
  await reminderController.markNotified(req, makeRes(), (e) => { captured = e; });
  assert.equal(captured.statusCode, 404);
});

test('status: 200 com active=false e canal/início ecoados (sem vazamento do estado alheio)', async () => {
  let seen = null;
  serviceImpl = {
    hasActiveReminder: async (userId, channelId, startMs) => {
      seen = { userId, channelId, startMs };
      return false;
    },
  };
  const req = { user: { id: 'u-1' }, query: { channelId: 'ch-1', startsAt: '1750000000000' } };
  const res = makeRes();
  await reminderController.status(req, res, () => {});
  assert.equal(res.statusCode, 200);
  assert.equal(res.sent.data.active, false);
  assert.equal(res.sent.data.channelId, 'ch-1');
  assert.equal(res.sent.data.startsAt, 1750000000000);
  assert.equal(seen.userId, 'u-1', 'identity sempre do token, nunca do query');
});

test('status: active=true repassa do service; data ISO também é aceita', async () => {
  serviceImpl = { hasActiveReminder: async () => true };
  const req = { user: { id: 'u-1' }, query: { channelId: 'ch-1', startsAt: '2026-09-20T20:00:00.000Z' } };
  const res = makeRes();
  await reminderController.status(req, res, () => {});
  assert.equal(res.statusCode, 200);
  assert.equal(res.sent.data.active, true);
  assert.equal(res.sent.data.startsAt, new Date('2026-09-20T20:00:00.000Z').getTime());
});

test('status: data inválida → 422 do service propaga por next (nunca 500)', async () => {
  serviceImpl = {
    hasActiveReminder: async () => { throw Object.assign(new Error('Data de início inválida.'), { statusCode: 422 }); },
  };
  let captured = null;
  const req = { user: { id: 'u-1' }, query: { channelId: 'ch-1', startsAt: 'lixo' } };
  await reminderController.status(req, makeRes(), (e) => { captured = e; });
  assert.equal(captured.statusCode, 422);
});

// ── Schema Joi (mass-assignment / limites) ────────────────────

const { schemas } = require('../src/middlewares/validate');

test('schema createReminder: stripUnknown — userId do corpo é descartado (mass-assignment)', () => {
  const { value, error } = schemas.createReminder.validate({
    channelId: 'ch-1',
    title: 'Jornal',
    startsAt: '2026-09-20T20:00:00.000Z',
    userId: 'hacker-123',       // NUNCA deve virar owner
    apiToken: 'invadido',       // idem
    role: 'admin',              // idem
  }, { stripUnknown: true, abortEarly: false });
  assert.equal(error, undefined);
  assert.ok(!('userId' in value));
  assert.ok(!('apiToken' in value));
  assert.ok(!('role' in value));
});

test('schema createReminder: exige channelId/título/startsAt válidos', () => {
  const check = (body) => schemas.createReminder.validate(body, { stripUnknown: true, abortEarly: false }).error;
  assert.ok(check({}), 'sem body → erro');
  assert.ok(check({ channelId: '', title: 'X', startsAt: '2026-09-20T20:00:00Z' }), 'channelId vazio');
  assert.ok(check({ channelId: 'ch-1', title: '', startsAt: '2026-09-20T20:00:00Z' }), 'título vazio');
  assert.ok(check({ channelId: 'ch-1', title: 'X', startsAt: '20/09/2026' }), 'data não-ISO');
  assert.ok(check({ channelId: 'ch-1', title: 'X', startsAt: '2026-09-20T20:00:00Z', stopAt: 'invalida' }), 'stopAt não-ISO');
});

// ── Rotas protegidas ──────────────────────────────────────────

const M3U_PATH = require.resolve('../src/services/m3uService');
class FakeM3U {
  static getShared() { if (!FakeM3U._s) FakeM3U._s = new FakeM3U(); return FakeM3U._s; }
  constructor() { this.channels = []; }
  getChannelById() { return null; }
  getAllChannels() { return []; }
  async ensureLoaded() { return this; }
}
FakeM3U._s = null;
require.cache[M3U_PATH] = { id: M3U_PATH, filename: M3U_PATH, loaded: true, exports: FakeM3U };

function startServer(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}
function closeServer(server) { return new Promise((resolve) => server.close(resolve)); }
function baseUrl(server) { return `http://127.0.0.1:${server.address().port}`; }

test('GET/POST/DELETE /api/user/reminders sem token → 401 (guarda requireSessionOrApi)', async () => {
  setDatabaseConnected(true);
  const express = require('express');
  require.cache[SERVICE_PATH].exports = { isEnabled: () => true };
  const userRoutes = require('../src/routes/userRoutes');

  const app = express();
  app.use('/api', userRoutes);
  const server = await startServer(app);
  try {
    const list = await fetch(`${baseUrl(server)}/api/user/reminders`);
    assert.equal(list.status, 401);
    const create = await fetch(`${baseUrl(server)}/api/user/reminders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelId: 'ch-1', title: 'X', startsAt: '2026-09-20T20:00:00Z' }),
    });
    assert.equal(create.status, 401);
    const del = await fetch(`${baseUrl(server)}/api/user/reminders/r-1`, { method: 'DELETE' });
    assert.equal(del.status, 401);
    const mark = await fetch(`${baseUrl(server)}/api/user/reminders/r-1/notified`, { method: 'POST' });
    assert.equal(mark.status, 401);
    const status = await fetch(`${baseUrl(server)}/api/user/reminders/status?channelId=ch-1&startsAt=1750000000000`);
    assert.equal(status.status, 401);
  } finally {
    await closeServer(server);
  }
});