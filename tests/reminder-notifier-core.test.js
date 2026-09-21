'use strict';

/**
 * Dispatcher "Avise-me" (public/js/reminder-notifier.js) — core puro.
 *
 * O MESMO arquivo servido ao navegador (global ReminderNotifier) é testado
 * aqui via CommonJS — sem DOM/rede. No Node o UMD exporta apenas as funções
 * puras (start/stop vivem só no browser).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { DEFAULTS, isDueReminder, buildNotificationPayload, makeLeaseKey } =
  require('../public/js/reminder-notifier');

const H = 60 * 60 * 1000;
const M = 60 * 1000;
// Referência fixa: 2026-09-19 12:00:00 UTC.
const T0 = Date.UTC(2026, 8, 19, 12, 0, 0);

function row(over = {}) {
  return {
    id: 'rem-1',
    channelId: 'ch-1',
    title: 'Jornal Hoje',
    startsAt: new Date(T0 + 30 * M).toISOString(),
    notifiedAt: null,
    ...over,
  };
}

// ── isDueReminder: janela [now-trail, now+lead] ─────────────────

test('isDueReminder: dentro da janela → true', () => {
  assert.equal(
    isDueReminder(row({ startsAt: new Date(T0 + 30 * 1000).toISOString() }), T0, 60 * 1000, 15 * 60 * 1000),
    true,
    'por vir em 30s, dentro do pré-aviso'
  );
  assert.equal(
    isDueReminder(row({ startsAt: new Date(T0 - 5 * 60 * 1000).toISOString() }), T0, 0, 15 * 60 * 1000),
    true,
    'início recente dentro do trail aceito'
  );
  assert.equal(
    isDueReminder(row({ startsAt: new Date(T0 + 50 * 1000).toISOString() }), T0, 60 * 1000, 0),
    true,
    'pré-aviso de 60s aceito'
  );
});

test('isDueReminder: fora da janela → false', () => {
  assert.equal(isDueReminder(null, T0, 60 * 1000, 15 * 60 * 1000), false, 'sem lembrete');
  assert.equal(
    isDueReminder(row({ startsAt: new Date(T0 + 2 * H).toISOString() }), T0, 60 * 1000, 15 * 60 * 1000),
    false,
    'ainda distante (além do pré-aviso)'
  );
  assert.equal(
    isDueReminder(row({ startsAt: new Date(T0 - 2 * H).toISOString() }), T0, 60 * 1000, 15 * 60 * 1000),
    false,
    'janela de recuperação (trail) vencida'
  );
  assert.equal(isDueReminder(row({ startsAt: 'nao-eh-data' }), T0, 60 * 1000, 15 * 60 * 1000), false, 'data inválida');
  assert.equal(
    isDueReminder(row({ notifiedAt: new Date().toISOString() }), T0, 60 * 1000, 15 * 60 * 1000),
    false,
    'two-phase já fechado (nunca re-notifica)'
  );
});

// ── buildNotificationPayload ───────────────────────────────────

test('buildNotificationPayload: título do programa + tag + ícone default', () => {
  const p = buildNotificationPayload(row(), DEFAULTS.icon, DEFAULTS.tagPrefix);
  assert.equal(p.title, 'Jornal Hoje está para começar', 'notifica que a programação está para começar');
  assert.equal(p.options.tag, 'sventv-reminder-rem-1');
  assert.equal(p.options.icon, '/img/favicon.png');
  assert.equal(p.options.body, 'Está começando agora no SvenTV.');
  assert.ok(Number.isFinite(p.startMs), 'startMs numérico');
});

test('buildNotificationPayload: sem título → fallback; título longo → truncado', () => {
  const fallback = buildNotificationPayload(row({ title: '  ' }), DEFAULTS.icon, DEFAULTS.tagPrefix);
  assert.equal(fallback.title, 'Programação está para começar');

  const t = buildNotificationPayload(row({ title: 'X'.repeat(300) }), DEFAULTS.icon, DEFAULTS.tagPrefix);
  assert.ok(t.title.length < 200, 'título truncado (~80 chars + sufixo)');
});

// ── makeLeaseKey (dedup cross-aba) ─────────────────────────────

test('makeLeaseKey: prefixo + id como string', () => {
  assert.equal(makeLeaseKey('rem-1', DEFAULTS.leasePrefix), 'sventv:rem:notify:rem-1');
  assert.equal(makeLeaseKey(42, 'pref:'), 'pref:42');
});