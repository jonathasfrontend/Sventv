'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  bigToNumber,
  formatWatchDuration,
  dayUtc,
  resolveRange,
  daysBetween,
  sweepPeak,
  hourBucketMax,
} = require('../src/utils/analytics');

test('bigToNumber converte BigInt/number/string e ignora inválidos', () => {
  assert.equal(bigToNumber(42n), 42);
  assert.equal(bigToNumber(42), 42);
  assert.equal(bigToNumber('42'), 42);
  assert.equal(bigToNumber(null), 0);
  assert.equal(bigToNumber(undefined), 0);
  assert.equal(bigToNumber({}), 0);
});

test('formatWatchDuration formata minutos/horas e trata 0/negativos', () => {
  assert.equal(formatWatchDuration(0), '0min');
  assert.equal(formatWatchDuration(-5000), '0min');
  assert.equal(formatWatchDuration(60000), '1min');
  assert.equal(formatWatchDuration(60 * 60 * 1000), '1h 0min');
  assert.equal(formatWatchDuration((8 * 60 + 42) * 60 * 1000), '8h 42min');
});

test('dayUtc zera hora/minuto/seg/millis mantendo a data', () => {
  const d = dayUtc(new Date('2026-09-12T15:34:56.789Z'));
  assert.equal(d.toISOString(), '2026-09-12T00:00:00.000Z');
});

test('resolveRange normaliza today/7d/30d/90d e rejeita inválidos', () => {
  const today = resolveRange({});
  assert.ok(today && today.start.getUTCHours() === 0);

  const week = resolveRange({ period: '7d' });
  const approx = Date.now() - 7 * 24 * 60 * 60 * 1000;
  assert.ok(Math.abs((week.start.getTime() - approx)) < 5000);

  assert.equal(resolveRange({ period: 'xxx' }), null);
  assert.equal(resolveRange({ period: 'custom', from: 'invalido' }), null);

  const custom = resolveRange({ period: 'custom', from: '2026-09-01', to: '2026-09-10' });
  assert.equal(custom.start.toISOString().slice(0, 10), '2026-09-01');
  assert.equal(custom.end.toISOString().slice(0, 10), '2026-09-10');
});

test('daysBetween inclui os dois extremos', () => {
  const days = daysBetween(new Date('2026-09-01T00:00:00Z'), new Date('2026-09-03T23:59:59Z'));
  assert.deepEqual(
    days.map((d) => d.toISOString().slice(0, 10)),
    ['2026-09-01', '2026-09-02', '2026-09-03']
  );
});

test('sweepPeak computa sobreposição de intervalos', () => {
  assert.equal(sweepPeak([]), 0);
  const intervals = [
    { start: new Date(1000), end: new Date(5000) },
    { start: new Date(2000), end: new Date(3000) },
    { start: new Date(7000), end: null }, // sem fim → 1 segundo
  ];
  assert.equal(sweepPeak(intervals), 2);
});

test('hourBucketMax agrupa por dia e pega a hora de pico', () => {
  const sessions = [
    [new Date('2026-09-12T10:15:00Z').getTime()],
    [new Date('2026-09-12T10:45:00Z').getTime()],
    [new Date('2026-09-12T11:00:00Z').getTime()],
    [new Date('2026-09-13T08:00:00Z').getTime()],
  ];
  const out = hourBucketMax(sessions);
  assert.equal(out['2026-09-12T00:00:00.000Z'], 2);
  assert.equal(out['2026-09-13T00:00:00.000Z'], 1);
});