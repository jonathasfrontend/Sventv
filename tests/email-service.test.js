'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const emailService = require('../src/services/emailService');

// ── buildPasswordResetEmail ──────────────────────────────────

test('buildPasswordResetEmail inclui o código e regras de segurança', () => {
  const { subject, text, html } = emailService.buildPasswordResetEmail('481516');

  assert.match(subject, /recuperação de senha/i);
  assert.ok(text.includes('481516'));
  assert.ok(text.includes('15 minutos'));
  assert.ok(text.includes('uma vez'));
  assert.ok(text.toLowerCase().includes('não compartilhe'));
  assert.ok(text.includes('senha permanece inalterada'), 'não solicitado → senha inalterada');

  assert.ok(html.includes('481516'));
  assert.ok(html.includes('15 minutos'));
  assert.ok(html.includes('Sven<span style="color:#22d3ee;">TV</span>'));
});

test('buildPasswordResetEmail nunca contém dados internos (host/URL/token) sem resetUrl', () => {
  const { html, text } = emailService.buildPasswordResetEmail('123456');
  const combined = (html + text).toLowerCase();
  assert.ok(!combined.includes('http'), 'não deve expor endereço de site');
  assert.ok(!combined.includes('smtp'), 'não deve expor config de smtp');
  assert.ok(!combined.includes('api/'), 'não deve expor endpoints');
  assert.ok(!combined.includes('vercel'), 'não deve expor plataforma');
});

test('buildPasswordResetEmail com resetUrl inclui link e botão de redefinição', () => {
  const url = 'https://sventv.app/reset-password?email=a%40b.com';
  const { html, text } = emailService.buildPasswordResetEmail('123456', url);

  assert.ok(html.includes(url));
  assert.ok(html.includes('Redefinir minha senha'), 'botão CTA presente');
  assert.ok(text.includes(url));
  assert.match(html, /href="https:\/\/sventv\.app\/reset-password\?email=a%40b\.com"/);
});

test('buildResetUrl monta link apenas com APP_BASE_URL configurado', () => {
  // Sem baseUrl configurada (teste roda sem APP_BASE_URL): retorno vazio.
  const config = require('../src/config/app');
  if (!config.app.baseUrl) {
    assert.equal(emailService.buildResetUrl('a@b.com'), '');
  } else {
    assert.ok(emailService.buildResetUrl('a@b.com').startsWith(`${config.app.baseUrl}/reset-password?email=`));
  }
});

// ── sendPasswordResetCode (transporter injetável, sem rede) ──

function fakeTransporter({ fail = false } = {}) {
  return {
    sendMail: async (opts) => {
      if (fail) throw new Error('ECONNECTION fake');
      assert.match(opts.to, /[^@]+@[^@]+/);
      assert.ok(opts.html && opts.text && opts.subject);
      return { messageId: 'msg-fake-1' };
    },
  };
}

test('envio bem-sucedido retorna messageId e passa opções completas', async () => {
  emailService._setTransporter(fakeTransporter());
  try {
    const out = await emailService.sendPasswordResetCode('a@b.com', '123456');
    assert.equal(out.messageId, 'msg-fake-1');
  } finally {
    emailService._setTransporter(null);
  }
});

test('falha de transporte vira erro GENÉRICO SMTP_FAILED (sem detalhes)', async () => {
  emailService._setTransporter(fakeTransporter({ fail: true }));
  try {
    await assert.rejects(
      () => emailService.sendPasswordResetCode('a@b.com', '123456'),
      (err) => err.message === 'SMTP_FAILED'
    );
  } finally {
    emailService._setTransporter(null);
  }
});

test('sem SMTP configurado e sem transporter injetado → erro SMTP_NOT_CONFIGURED', async () => {
  const config = require('../src/config/app');
  const prevEnabled = config.smtp.enabled;
  const prevTransporter = emailService.getTransporter();

  emailService._setTransporter(null);
  config.smtp.enabled = false; // força desligado independente do .env local
  try {
    await assert.rejects(
      () => emailService.sendPasswordResetCode('a@b.com', '123456'),
      (err) => err.message === 'SMTP_NOT_CONFIGURED'
    );
  } finally {
    config.smtp.enabled = prevEnabled;
    emailService._setTransporter(prevTransporter);
  }
});