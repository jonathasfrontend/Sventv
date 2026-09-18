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

// ── Lembrete de programação ("Avise-me") ──────────────────────

const REMINDER_OPTS = {
  channelName: 'Globo HD',
  programTitle: 'Jornal Nacional',
  startsAt: Date.parse('2026-09-18T20:00:00.000Z'),
  stopAt: Date.parse('2026-09-18T21:00:00.000Z'),
  appUrl: '',
  timeZone: 'UTC',
};

test('buildReminderEmail: subject/corpo/HTML têm canal, programa e instante', () => {
  const { subject, text, html } = emailService.buildReminderEmail(REMINDER_OPTS);
  assert.equal(subject, 'SvenTV — Jornal Nacional começa agora');
  assert.ok(text.includes('Globo HD'));
  assert.ok(text.includes('Jornal Nacional'));
  assert.ok(text.includes('sexta-feira'), 'instante formatado (UTC, pt-BR), 2026-09-18 é sexta');
  assert.ok(html.includes('Jornal Nacional'));
  assert.ok(html.includes('Globo HD'));
  assert.ok(!html.includes('https://'), 'sem URL quando appUrl ausente');
});

test('buildReminderEmail: appUrl gera CTA e link /guia', () => {
  const { text, html } = emailService.buildReminderEmail({ ...REMINDER_OPTS, appUrl: 'https://sventv.app' });
  assert.ok(text.includes('https://sventv.app/guia'));
  assert.ok(html.includes('Assistir ao vivo'));
});

test('buildReminderEmail: conteúdo externo é saneado (CR/LF e HTML no subject/corpo)', () => {
  const malicious = emailService.buildReminderEmail({
    channelName: 'Globo\r\nBcc: v@mal.com',
    programTitle: '<b>Jornal</b> & "aspas"\n\nVisor',
    startsAt: Date.parse('2026-09-19T21:00:00.000Z'),
    appUrl: 'https://sventv.app\nX-Injected: 1',
    timeZone: 'UTC',
  });
  // Subject é HEADER → quebras são neutralizadas (o `Bcc:` vira texto, nunca
  // uma linha nova de cabeçalho). NÃO aplicamos escape HTML no subject.
  assert.ok(!malicious.subject.includes('\n'), 'CR/LF neutralizados no subject (header injection)');
  assert.ok(!malicious.subject.includes('\r'), 'CR neutralizado no subject');
  assert.ok(!malicious.subject.includes('\nBcc:'), 'header injection neutralizada no subject');
  // O canal com CR/LF vira TEXTO no corpo (nunca cabeçalho).
  assert.ok(malicious.text.includes('Bcc: v@mal.com'), 'channelName neutralizado vira texto no corpo');
  assert.ok(!malicious.text.includes('\nBcc:'), 'nenhuma linha nova de cabeçalho no corpo texto');
  // Corpo HTML é onde HTML injection importa → escapado.
  assert.ok(malicious.html.includes('&lt;b&gt;'), 'HTML escapado');
  assert.ok(malicious.html.includes('&amp;'), 'ampersand escapado');
  assert.ok(malicious.html.includes('&quot;aspas&quot;'), 'aspas escapadas');
  assert.ok(!malicious.html.includes('<b>Jornal</b>'), 'tag crua jamais interpolada no HTML');
  assert.ok(!malicious.html.includes('\nX-Injected:'), 'appUrl com quebra não vira heading no HTML');
});

test('buildReminderEmail: timeZone controla o instante exibido (determinístico em teste)', () => {
  const saoPaulo = emailService.buildReminderEmail({ ...REMINDER_OPTS, timeZone: 'America/Sao_Paulo' });
  const utc = emailService.buildReminderEmail({ ...REMINDER_OPTS, timeZone: 'UTC' });
  assert.ok(saoPaulo.text.includes('17:00'), '20:00Z = 17:00 em São Paulo');
  assert.ok(utc.text.includes('20:00'), 'UTC mantém 20:00');
  assert.ok(saoPaulo.text.includes('Horário de Brasília'), 'label do fuso explícito');
  assert.ok(utc.text.includes('Horário universal (UTC)'), 'label do fuso explícito no UTC');
});

test('buildReminderEmail: instante inválido → campo vazio (sem lançar)', () => {
  const out = emailService.buildReminderEmail({ ...REMINDER_OPTS, startsAt: Number.NaN });
  assert.ok(!out.text.includes('undefined'), 'sem "undefined" no corpo');
  assert.ok(out.subject.length > 0);
});

test('sendReminderEmail: transporte fake recebe payload completo e devolve messageId', async () => {
  let sent = null;
  emailService._setTransporter({
    sendMail: async (opts) => { sent = opts; return { messageId: 'rem-msg-1' }; },
  });
  try {
    const out = await emailService.sendReminderEmail({ ...REMINDER_OPTS, email: 'u@exemplo.com' });
    assert.equal(out.messageId, 'rem-msg-1');
    assert.equal(sent.to, 'u@exemplo.com');
    assert.ok(sent.subject && sent.text && sent.html);
  } finally {
    emailService._setTransporter(null);
  }
});

test('sendReminderEmail: falha de transporte → erro genérico SMTP_FAILED', async () => {
  emailService._setTransporter({ sendMail: async () => { throw new Error('ECONNECTION'); } });
  try {
    await assert.rejects(
      () => emailService.sendReminderEmail({ ...REMINDER_OPTS, email: 'u@exemplo.com' }),
      (err) => err.message === 'SMTP_FAILED'
    );
  } finally {
    emailService._setTransporter(null);
  }
});

test('sendReminderEmail: sem SMTP configurado → SMTP_NOT_CONFIGURED (não marca naíthing no caller)', async () => {
  const config = require('../src/config/app');
  const prevEnabled = config.smtp.enabled;
  const prevTransporter = emailService.getTransporter();
  emailService._setTransporter(null);
  config.smtp.enabled = false;
  try {
    await assert.rejects(
      () => emailService.sendReminderEmail({ ...REMINDER_OPTS, email: 'u@exemplo.com' }),
      (err) => err.message === 'SMTP_NOT_CONFIGURED' && !/host|credencial/i.test(err.message)
    );
  } finally {
    config.smtp.enabled = prevEnabled;
    emailService._setTransporter(prevTransporter);
  }
});