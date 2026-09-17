'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const ChannelStateService = require('../src/services/channelStateService');

// persistEnabled: false → serviço 100% em memória (sem tocar no banco).
// get/entry/isPlayable são async (read-through da fonte Postgres).
const makeSvc = () => new ChannelStateService({ persistEnabled: false });

test('estado padrão é live e isPlayable retorna true', async () => {
  const svc = makeSvc();
  assert.equal(await svc.get('x'), 'live');
  assert.equal(await svc.isPlayable('x'), true);
  assert.equal(await svc.entry('x'), null);
});

test('set válido registra estado/razão e preserva prevState', async () => {
  const svc = makeSvc();
  svc.set('x', 'maintenance', { reason: 'troca de servidor', actor: 'admin@x.dev' });

  assert.equal(await svc.get('x'), 'maintenance');
  assert.equal(await svc.isPlayable('x'), false);

  const entry = await svc.entry('x');
  assert.equal(entry.reason, 'troca de servidor');
  assert.equal(entry.setBy, 'admin@x.dev');
  assert.ok(entry.updatedAt);

  const result = svc.set('x', 'live');
  assert.equal(result.prevState, 'maintenance');
  assert.equal(result.state, 'live');
  assert.equal(await svc.get('x'), 'live');
});

test('set inválido lança erro 422/VALIDATION', async () => {
  const svc = makeSvc();
  assert.throws(
    () => svc.set('x', 'explodido'),
    (err) => err.statusCode === 422 && err.code === 'VALIDATION'
  );
  assert.equal(await svc.get('x'), 'live');
});

test('razão é truncada em 255 caracteres', async () => {
  const svc = makeSvc();
  svc.set('x', 'blocked', { reason: 'r'.repeat(400) });
  assert.equal((await svc.entry('x')).reason.length, 255);
});

test('all lista apenas os estados registrados', () => {
  const svc = makeSvc();
  svc.set('a', 'blocked');
  svc.set('b', 'live');
  const all = svc.all();
  assert.equal(all.length, 2);
  assert.deepEqual(all.map((e) => e.id).sort(), ['a', 'b']);
});

test('peek lê da memória sem consultar banco (espelho channel.state)', async () => {
  const svc = makeSvc();
  assert.equal(svc.peek('x'), 'live');
  svc.set('x', 'blocked');
  assert.equal(svc.peek('x'), 'blocked');
});

test('getShared retorna sempre a mesma instância (singleton)', () => {
  assert.equal(ChannelStateService.getShared(), ChannelStateService.getShared());
});