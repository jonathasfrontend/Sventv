'use strict';

/**
 * Shape do payload do webhook/email de alertas (regressão do caso real):
 * envio de {text} para webhook do Discord retorna HTTP 400 ("cannot send
 * an empty message") e o alerta NUNCA chega — o sintoma observado em
 * produção (`Alerta webhook falhou (admin.role_escalation:...)` sem
 * notificação no Discord).
 *
 * Regra (novo desenho UX/UI):
 *   - host discord.com / discordapp.com + path /api/webhooks/* → {content}
 *     + {embeds} rico (título, cor por evento, campos rotulados, timestamp);
 *   - Slack e genéricos → {text};
 *   - e-mail → HTML com design (todos os valores escapados) + fallback texto.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const alertService = require('../src/services/alertService');
const { _webhookPayloadFor } = alertService;

const DISCORD_URL = 'https://discord.com/api/webhooks/123456/TOKEN';
const DETAILS = { userId: 'u-1', email: 'ana@x.com', name: 'Ana' };
const MALICIOUS = { email: 'a<b>&"c', name: '<script>alert(1)</script>' };

test('webhook do Discord retorna content + embed rico', () => {
  const payload = _webhookPayloadFor('auth.user_registered:u-1\n{"email":"ana@x.com"}', 'auth.user_registered:u-1', DETAILS, DISCORD_URL);
  assert.ok(typeof payload.content === 'string' && payload.content.length > 0);
  assert.ok(Array.isArray(payload.embeds) && payload.embeds.length === 1);
  const embed = payload.embeds[0];
  assert.ok(embed.title.includes('Novo usuário registrado'), 'título por evento');
  assert.equal(embed.color, 0x16a34a, 'cor por evento (verde)');
  assert.ok(embed.description.includes('auth.user_registered:u-1'));
  assert.ok(embed.fields.some((f) => f.name === 'E-mail' && f.value.includes('ana@x.com')));
  assert.ok(embed.fields.some((f) => f.name === 'Nome' && f.value.includes('Ana')));
  assert.ok(embed.footer.text.includes('usuário'));
  assert.ok(new Date(embed.timestamp).toISOString(), 'timestamp ISO');
});

test('embed usa cor de segurança para role_escalation (vermelho)', () => {
  const payload = _webhookPayloadFor('k', 'admin.role_escalation:u1:123', DETAILS, DISCORD_URL);
  assert.equal(payload.embeds[0].color, 0xdc2626);
  assert.ok(payload.embeds[0].title.includes('promovido'));
});

test('webhook do Discord (discordapp.com legado) usa content + embeds', () => {
  const payload = _webhookPayloadFor('mensagem', 'channelHealth.failback', {}, 'https://discordapp.com/api/webhooks/123/abc');
  assert.ok(payload.content && Array.isArray(payload.embeds));
  assert.equal(payload.embeds[0].color, 0x16a34a);
});

test('evento sem metadados usa DEFAULT (🔔 / roxo / sistema)', () => {
  const payload = _webhookPayloadFor('k', 'evento.teste', { a: 1 }, DISCORD_URL);
  assert.equal(payload.embeds[0].color, 0x7c3aed);
  assert.ok(payload.embeds[0].title.includes('🔔'));
  assert.ok(payload.embeds[0].footer.text.includes('sistema'));
});

test('webhook do Slack continua usando campo text', () => {
  const payload = _webhookPayloadFor('mensagem', 'auth.user_registered:u1', DETAILS, 'https://hooks.slack.com/services/T000/B000/XXXX');
  assert.deepEqual(payload, { text: 'mensagem' });
});

test('URL genérica mantém campo text (retrocompatível)', () => {
  const payload = _webhookPayloadFor('mensagem', 'auth.user_registered:u1', DETAILS, 'https://example.com/hooks/x');
  assert.deepEqual(payload, { text: 'mensagem' });
});

test('host discord.com mas fora do path /api/webhooks/ vira text', () => {
  const payload = _webhookPayloadFor('mensagem', 'a.b', {}, 'https://discord.com/not-a-webhook');
  assert.deepEqual(payload, { text: 'mensagem' });
});

test('URL inválida/vazia não derruba e mantém text', () => {
  assert.deepEqual(_webhookPayloadFor('mensagem', 'a.b', {}, 'not a url'), { text: 'mensagem' });
  assert.deepEqual(_webhookPayloadFor('mensagem', 'a.b', {}, ''), { text: 'mensagem' });
  assert.deepEqual(_webhookPayloadFor('mensagem', 'a.b', {}, null), { text: 'mensagem' });
});

test('notify: e-mail envia HTML de design + texto, e valores são escapados', async () => {
  alertService.resetCooldown();
  let email = null;
  alertService._setSinks({ sendEmail: async (payload) => { email = payload; } });
  try {
    alertService.notify('auth.user_registered:u-1', MALICIOUS);
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(email, 'sink de e-mail capturou');
    assert.ok(email.html.startsWith('<!doctype html>'));
    assert.ok(email.html.includes('Novo usuário registrado'), 'título por evento no HTML');
    assert.ok(email.html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'HTML escapado, sem <script> cru');
    assert.ok(email.html.includes('a&lt;b&gt;&amp;&quot;c'), 'Email escapado corretamente');
    assert.ok(!email.html.includes('<script>'), 'nenhum script cru no HTML');
    assert.ok(email.html.includes('Sven<span'), 'branding no cabeçalho');
    assert.ok(email.text.includes('auth.user_registered:u-1'), 'fallback texto mantém eventKey');
  } finally {
    alertService._setSinks(null);
    alertService.resetCooldown();
  }
});

test('notify: sink de webhook recebe (text, payload) — texto compatível e payload estruturado', async () => {
  alertService.resetCooldown();
  let captured = null;
  alertService._setSinks({ sendWebhook: async (text, payload) => { captured = { text, payload }; } });
  try {
    alertService.notify('admin.role_escalation:usr-9:123', { targetEmail: 'alvo@example.com', changedBy: 'root@example.com' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(captured.text.includes('admin.role_escalation:usr-9:123'));
    assert.ok(captured.payload.embeds && captured.payload.embeds[0]);
    assert.ok(captured.payload.embeds[0].fields.some((f) => f.name === 'E-mail do alvo'));
    assert.ok(captured.text.includes('alvo@example.com'));
  } finally {
    alertService._setSinks(null);
    alertService.resetCooldown();
  }
});