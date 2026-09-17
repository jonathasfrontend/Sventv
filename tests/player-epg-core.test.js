'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

// O mesmo arquivo servido ao navegador (/Player/epgBar.js → global
// EpgBarCore) é testado aqui via CommonJS — sem DOM, sem rede.
const { normalizeProgrammes, computeView, computeProgress, toMs, cleanText } =
  require('../src/Player/epgBar');

// Janela fixa de referência (epoch ms). 2026-09-17 12:00:00 UTC.
const H = 60 * 60 * 1000;
const M = 60 * 1000;
const T0 = Date.UTC(2026, 8, 17, 12, 0, 0);

// ── toMs / cleanText ──────────────────────────────────────────

test('toMs aceita número e ISO 8601 UTC e rejeita valores inválidos', () => {
  assert.equal(toMs(T0), T0);
  assert.equal(toMs('2026-09-17T12:00:00.000Z'), T0);
  assert.equal(toMs(''), null);
  assert.equal(toMs('nao-eh-data'), null);
  assert.equal(toMs(null), null);
  assert.equal(toMs(undefined), null);
  assert.equal(toMs(Number.NaN), null);
});

test('cleanText normaliza string/trim', () => {
  assert.equal(cleanText('  Olá  '), 'Olá');
  assert.equal(cleanText(null), '');
  assert.equal(cleanText(0), '0');
});

test('normalizeProgrammes respeita offset ISO (timezone consistente)', () => {
  // -0300 vira UTC (15:00 -0300 == 18:00 UTC).
  const list = normalizeProgrammes([
    { start: '2026-09-17T15:00:00-03:00', stop: '2026-09-17T16:00:00-03:00', title: 'Jornal' },
  ]);
  assert.equal(list.length, 1);
  assert.equal(list[0].start, Date.UTC(2026, 8, 17, 18, 0, 0));
  assert.equal(list[0].stop, Date.UTC(2026, 8, 17, 19, 0, 0));
});

// ── Normalização / validação ──────────────────────────────────

test('normalizeProgrammes descarta entradas inválidas sem lançar', () => {
  const list = normalizeProgrammes([
    null,
    'texto',
    { title: 'sem tempo' },
    { start: 'abc', stop: '2026-09-17T13:00:00.000Z', title: 'tempo ruim' },
    { start: '2026-09-17T13:00:00.000Z', stop: 'abc', title: 'stop ruim' },
    { start: '2026-09-17T14:00:00.000Z', stop: '2026-09-17T13:00:00.000Z', title: 'stop <= start' },
    { start: '2026-09-17T13:00:00.000Z', stop: '2026-09-17T14:00:00.000Z', title: 'válido' },
  ]);
  assert.equal(list.length, 1);
  assert.equal(list[0].title, 'válido');
});

test('normalizeProgrammes aplica fallback de título e ordena por start ASC', () => {
  const list = normalizeProgrammes([
    { start: '2026-09-17T14:00:00.000Z', stop: '2026-09-17T15:00:00.000Z', title: 'B' },
    { start: '2026-09-17T12:00:00.000Z', stop: '2026-09-17T13:00:00.000Z', title: '  ' },
    { start: '2026-09-17T13:00:00.000Z', stop: '2026-09-17T14:00:00.000Z', title: 'A' },
  ]);
  assert.equal(list.length, 3);
  assert.deepEqual(list.map((p) => p.title), ['Programação', 'A', 'B']);
  assert.ok(list[0].start < list[1].start && list[1].start < list[2].start);
});

test('normalizeProgrammes aceita números (ms) e strings ISO mistos', () => {
  const list = normalizeProgrammes([
    { start: T0, stop: T0 + H, title: 'Num' },
    { start: new Date(T0 + 2 * H).toISOString(), stop: new Date(T0 + 3 * H).toISOString(), title: 'ISO' },
  ]);
  assert.equal(list.length, 2);
  assert.equal(list[0].title, 'Num');
  assert.equal(list[1].title, 'ISO');
});

test('normalizeProgrammes não normaliza em excesso (mantém subtitle/description)', () => {
  const list = normalizeProgrammes([{ start: T0, stop: T0 + H, title: 'X', subtitle: 'Sub', description: 'Desc' }]);
  assert.equal(list[0].subtitle, 'Sub');
  assert.equal(list[0].description, 'Desc');
});

// ── computeView: atual / próximo ──────────────────────────────

function prog(start, stop, title) {
  return { start, stop, title, subtitle: '', description: '' };
}

test('computeView: encontra o programa atual e o próximo', () => {
  const list = [
    prog(T0 - H, T0 + H, 'A'),      // começou antes e continua agora
    prog(T0 + 2 * H, T0 + 3 * H, 'B'),
    prog(T0 + 3 * H, T0 + 4 * H, 'C'),
  ];
  const view = computeView(list, T0);
  assert.equal(view.current.title, 'A');
  assert.equal(view.next.title, 'B');
  assert.equal(view.hasGap, false);
});

test('computeView: antes do primeiro programa → gap com próximo', () => {
  const list = [prog(T0 + H, T0 + 2 * H, 'A')];
  const view = computeView(list, T0);
  assert.equal(view.current, null);
  assert.equal(view.next.title, 'A');
  assert.equal(view.hasGap, true);
});

test('computeView: depois do último programa → exaurido', () => {
  const list = [prog(T0, T0 + H, 'A')];
  const view = computeView(list, T0 + 2 * H);
  assert.equal(view.current, null);
  assert.equal(view.next, null);
  assert.equal(view.hasGap, true);
  assert.equal(view.exhausted, true);
});

test('computeView: no exato horário de troca, o programa que termina NÃO é o atual', () => {
  const list = [prog(T0, T0 + H, 'A'), prog(T0 + H, T0 + 2 * H, 'B')];
  const view = computeView(list, T0 + H);
  assert.equal(view.current.title, 'B');  // A.stop é exclusivo
  assert.equal(view.next, null);
});

// ── Transição A → B → C (local, sem rede) ─────────────────────

test('computeView: transições A→B→C acompanhando o relógio', () => {
  const list = [
    prog(T0, T0 + H, 'A'),
    prog(T0 + H, T0 + 2 * H, 'B'),
    prog(T0 + 2 * H, T0 + 3 * H, 'C'),
  ];

  const t1 = computeView(list, T0 + 10 * M);
  assert.equal(t1.current.title, 'A');
  assert.equal(t1.next.title, 'B');

  const t2 = computeView(list, T0 + H + 10 * M);
  assert.equal(t2.current.title, 'B');
  assert.equal(t2.next.title, 'C');

  const t3 = computeView(list, T0 + 2 * H + 10 * M);
  assert.equal(t3.current.title, 'C');
  assert.equal(t3.next, null); // exaurido

  const t4 = computeView(list, T0 + 4 * H);
  assert.equal(t4.current, null);
  assert.equal(t4.exhausted, true);
});

// ── Progresso ─────────────────────────────────────────────────

test('computeProgress: 0%, 50%, 100% e clamp', () => {
  const p = prog(T0, T0 + H, 'A');
  assert.equal(computeProgress(p, T0), 0);
  assert.equal(computeProgress(p, T0 + H / 2), 50);
  assert.equal(computeProgress(p, T0 + H), 100);
  // clamp
  assert.equal(computeProgress(p, T0 - H), 0);
  assert.equal(computeProgress(p, T0 + 2 * H), 100);
});

test('computeProgress: duração zero ou inválida → 100%', () => {
  assert.equal(computeProgress({ start: T0, stop: T0, title: 'Z' }, T0), 100);
  assert.equal(computeProgress({ start: T0, stop: T0 - H, title: 'Z' }, T0), 100);
  assert.equal(computeProgress(null, T0), 0);
});

test('computeProgress: dentro da janela, progride monotonicamente', () => {
  const p = { start: T0, stop: T0 + 2 * H, title: 'Longa' };
  const a = computeProgress(p, T0 + 30 * M);
  const b = computeProgress(p, T0 + 90 * M);
  const c = computeProgress(p, T0 + 2 * H);
  assert.ok(a < b && b < c);
  assert.equal(c, 100);
});

// ── Gap na programação ────────────────────────────────────────

test('computeView: gap entre programas (sem cobertura de now)', () => {
  const list = [
    prog(T0, T0 + H, 'A'),
    prog(T0 + 2 * H, T0 + 3 * H, 'B'), // fura de 1h
  ];
  const view = computeView(list, T0 + H + 30 * M);
  assert.equal(view.current, null);
  assert.equal(view.next.title, 'B');
  assert.equal(view.hasGap, true);
});

test('EPG vazio → semanticamente barra oculta (sem current/next)', () => {
  const view = computeView([], T0);
  assert.equal(view.current, null);
  assert.equal(view.next, null);
  assert.equal(view.hasGap, true);
  assert.equal(view.exhausted, true);
});