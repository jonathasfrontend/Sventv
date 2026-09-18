'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const ReminderBarCore = require('../src/Player/reminderBar');

const NOW = Date.parse('2026-09-18T18:00:00.000Z');
const HORIZON = 24 * 60 * 60 * 1000;

// ── toEpochMs ──────────────────────────────────────────────────

test('toEpochMs: aceita ISO 8601 e timestamps numéricos', () => {
  assert.equal(ReminderBarCore.toEpochMs('2026-09-18T19:00:00.000Z'), Date.parse('2026-09-18T19:00:00.000Z'));
  assert.equal(ReminderBarCore.toEpochMs(1780000000000), 1780000000000);
  assert.equal(ReminderBarCore.toEpochMs(1780000000000.4), 1780000000000, 'arredonda ms');
});

test('toEpochMs: rejeita inválidos (null/undefined/NaN/texto não datável/vazio)', () => {
  assert.equal(ReminderBarCore.toEpochMs(null), null);
  assert.equal(ReminderBarCore.toEpochMs(undefined), null);
  assert.equal(ReminderBarCore.toEpochMs(Number.NaN), null);
  assert.equal(ReminderBarCore.toEpochMs(''), null);
  assert.equal(ReminderBarCore.toEpochMs('  '), null);
  assert.equal(ReminderBarCore.toEpochMs('amanhã'), null);
  assert.equal(ReminderBarCore.toEpochMs(Infinity), null);
});

// ── shouldSuggestReminder ─────────────────────────────────────

test('shouldSuggestReminder: programa futuro dentro do horizonte → true', () => {
  const programme = { start: NOW + 30 * 60 * 1000, stop: NOW + 60 * 60 * 1000, title: 'Filme' };
  assert.equal(ReminderBarCore.shouldSuggestReminder(programme, NOW, HORIZON), true);
});

test('shouldSuggestReminder: programa no limite exato do horizonte → true', () => {
  const programme = { start: NOW + HORIZON, stop: NOW + HORIZON + 1000, title: 'Limite' };
  assert.equal(ReminderBarCore.shouldSuggestReminder(programme, NOW, HORIZON), true);
});

test('shouldSuggestReminder: além do horizonte (server 422) → false', () => {
  const programme = { start: NOW + HORIZON + 1, stop: NOW + HORIZON + 1000, title: 'Demais' };
  assert.equal(ReminderBarCore.shouldSuggestReminder(programme, NOW, HORIZON), false);
});

test('shouldSuggestReminder: programa já começou ou terminado → false (não se lembra do atual)', () => {
  assert.equal(ReminderBarCore.shouldSuggestReminder({ start: NOW - 1000, stop: NOW + 1000, title: 'Atual' }, NOW, HORIZON), false);
  assert.equal(ReminderBarCore.shouldSuggestReminder({ start: NOW - 5000, stop: NOW - 1000, title: 'Passado' }, NOW, HORIZON), false);
  // Exatamente no ar = start == now → também não.
  assert.equal(ReminderBarCore.shouldSuggestReminder({ start: NOW, stop: NOW + 1000, title: 'Início' }, NOW, HORIZON), false);
});

test('shouldSuggestReminder: sem programa/início inválido → false (sem lançar)', () => {
  assert.equal(ReminderBarCore.shouldSuggestReminder(null, NOW, HORIZON), false);
  assert.equal(ReminderBarCore.shouldSuggestReminder({}, NOW, HORIZON), false);
  assert.equal(ReminderBarCore.shouldSuggestReminder({ title: 'Sem hora' }, NOW, HORIZON), false);
  assert.equal(ReminderBarCore.shouldSuggestReminder(42, NOW, HORIZON), false);
});

// ── buildPayload ──────────────────────────────────────────────

test('buildPayload: monta {channelId, programTitle, programStart} em epoch ms', () => {
  const payload = ReminderBarCore.buildPayload({
    channelId: 'chl-a1',
    programme: { start: '2026-09-18T19:00:00.000Z', stop: NOW + 1000, title: '  Jornal Nacional  ' },
  });
  assert.deepEqual(payload, {
    channelId: 'chl-a1',
    programTitle: 'Jornal Nacional',
    programStart: Date.parse('2026-09-18T19:00:00.000Z'),
  });
});

test('buildPayload: aceita programme.start numérico e corta título em 255 chars', () => {
  const long = 'x'.repeat(400);
  const payload = ReminderBarCore.buildPayload({
    channelId: 'chl-b2',
    programme: { start: NOW + 60000, title: long },
  });
  assert.equal(payload.programTitle.length, 255);
  assert.equal(payload.programStart, NOW + 60000);
});

test('buildPayload: null quando falta canal/programa/início/título utilizável', () => {
  assert.equal(ReminderBarCore.buildPayload({ channelId: 'chl', programme: null }), null);
  assert.equal(ReminderBarCore.buildPayload({ channelId: '', programme: { start: 'x' } }), null);
  assert.equal(ReminderBarCore.buildPayload({ channelId: 'chl', programme: {} }), null);
  assert.equal(ReminderBarCore.buildPayload({ channelId: 'chl', programme: { start: 'invalido', title: 'a' } }), null);
  assert.equal(ReminderBarCore.buildPayload({ channelId: 'chl', programme: { start: NOW + 1000, title: '   ' } }), null);
  assert.equal(ReminderBarCore.buildPayload({}), null);
});