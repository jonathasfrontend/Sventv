/**
 * SvenTV API — Serviço de E-mail (SMTP via Nodemailer)
 *
 * Responsável por e-mails transacionais. Atualmente: recuperação de senha.
 *
 * Segurança:
 *  - credenciais SMTP vivem APENAS no ambiente (config.smtp) — nunca logar,
 *    nunca responder ao cliente, nunca expor o motivo técnico da falha;
 *  - o template nunca inclui senha, token, link com segredo ou dados
 *    internos (endpoints, hosts, IPs);
 *  - falha de envio é logada internamente (stack/warn) e o fluxo externo
 *    continua GENÉRICO — o chamador decide como responder;
 *  - `_setTransporter` é a emenda para testes (transporte fake) — nos testes
 *    nunca há SMTP real.
 */

'use strict';

const nodemailer = require('nodemailer');
const config = require('../config/app');
const logger = require('../utils/logger');

const PLATFORM_NAME = 'SvenTV';

let _transporter = null;

function createTransporter() {
  return nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: config.smtp.user
      ? { user: config.smtp.user, pass: config.smtp.pass }
      : undefined,
  });
}

/**
 * Retorna o transporter (lazy). null quando SMTP não configurado.
 */
function getTransporter() {
  if (_transporter) return _transporter;
  if (!config.smtp.enabled) return null;
  _transporter = createTransporter();
  return _transporter;
}

/**
 * Emenda de teste: injeta um transporter/send fake. Pass null para resetar
 * para o comportamento real (SMTP configurado) ou nulo (não configurado).
 */
function _setTransporter(t) {
  _transporter = t;
}

/**
 * Renderiza o e-mail de recuperação de senha.
 * @param {string} code código de 6 dígitos
 * @param {string} [resetUrl] link opcional para a página de redefinição
 *   (montado com o domínio público configurado — nunca inventado)
 * @returns {{ subject: string, text: string, html: string }}
 */
function buildPasswordResetEmail(code, resetUrl = '') {
  const subject = `${PLATFORM_NAME} — Código de recuperação de senha`;

  const text = [
    `Olá!`,
    ``,
    `Você (ou alguém) solicitou a recuperação da senha da sua conta ${PLATFORM_NAME}.`,
    ``,
    `Seu código de verificação é: ${code}`,
    ``,
    `Ele é válido por 15 minutos e pode ser usado apenas uma vez.`,
    ``,
  ];

  if (resetUrl) {
    text.push(`Para redefinir sua senha, acesse o link abaixo:`, ``);
    text.push(`${resetUrl}`, ``);
  } else {
    text.push(
      `Acesse a página de recuperação de senha do site e informe o código ${code}.`,
      ``
    );
  }

  text.push(
    `Não compartilhe este código com ninguém. Se você não solicitou esta`,
    `recuperação, ignore este e-mail — sua senha permanece inalterada e`,
    `recomendamos revisar a segurança da sua conta.`,
    ``,
    `Equipe ${PLATFORM_NAME}`
  );

  const ctaHtml = resetUrl
    ? `<div style="margin:20px 0 0;">
          <a href="${resetUrl}" style="display:inline-block;padding:13px 28px;background:#22d3ee;color:#0a0f14;text-decoration:none;font-weight:700;font-size:14px;border-radius:10px;">
            Redefinir minha senha
          </a>
        </div>`
    : '';

  const html = `
  <!DOCTYPE html>
  <html lang="pt-BR">
  <body style="margin:0;padding:0;background:#0a0f14;font-family:Inter,Arial,sans-serif;color:#e6edf3;">
    <div style="max-width:520px;margin:0 auto;padding:32px 16px;">
      <div style="text-align:center;padding:24px;background:#111820;border:1px solid #22303a;border-radius:16px;">
        <div style="font-size:22px;font-weight:800;letter-spacing:-0.02em;color:#e6edf3;">
          Sven<span style="color:#22d3ee;">TV</span>
        </div>
        <h1 style="font-size:18px;margin:18px 0 6px;color:#e6edf3;">Código de recuperação de senha</h1>
        <p style="font-size:14px;color:#8aa0ae;margin:0 0 20px;">
          Use o código abaixo para redefinir a senha da sua conta.
        </p>

        <div style="display:inline-block;padding:18px 32px;background:#0a0f14;border:1px dashed #22d3ee;border-radius:12px;font-size:30px;font-weight:800;letter-spacing:0.35em;color:#22d3ee;font-variant-numeric:tabular-nums;">
          ${code}
        </div>

        ${ctaHtml}

        <p style="font-size:13px;color:#8aa0ae;margin:22px 0 0;line-height:1.6;">
          O código é válido por <strong style="color:#e6edf3;">15 minutos</strong> e pode ser usado
          <strong style="color:#e6edf3;">apenas uma vez</strong>.
        </p>

        <div style="margin-top:18px;padding:12px 14px;background:#1a1212;border:1px solid #5a2a2a;border-radius:10px;font-size:12px;color:#f4b5b5;line-height:1.6;">
          Não compartilhe este código com ninguém. Se você não solicitou essa
          recuperação, ignore este e-mail — sua senha permanece inalterada e
          recomendamos revisar a segurança da sua conta.
        </div>
      </div>
      <p style="text-align:center;font-size:11px;color:#5c6f7c;margin-top:18px;">
        ${PLATFORM_NAME} · API de Streaming · São Paulo, Brasil
      </p>
    </div>
  </body>
  </html>`;

  return { subject, text: text.join('\n'), html };
}

/**
 * Monta o link de recuperação se existir domínio público configurado.
 * O e-mail só é incluído na query string se APP_BASE_URL existir.
 */
function buildResetUrl(email) {
  const base = (config.app && config.app.baseUrl) || '';
  if (!base) return '';
  const clean = String(email || '').replace(/[\r\n]/g, '').slice(0, 254);
  return `${base}/reset-password?email=${encodeURIComponent(clean)}`;
}

/**
 * Envia o código de recuperação para o e-mail.
 *
 * NUNCA lança para o chamador em falha de SMTP: registra internamente e
 * rethrows? — NÃO: a decisão de "genérico externo" é da camada de serviço,
 * mas aqui garantimos que um erro de transporte NUNCA contenha credenciais
 * nem host na mensagem que possa vazar. Mantemos a semântica: lança erro
 * genérico para o caller tratar (o caller esconde tudo do cliente).
 *
 * @param {string} email destinatário
 * @param {string} code código de 6 dígitos
 * @throws {Error} genérico ("SMTP_FAILED") sem detalhes — o chamador decide
 */
async function sendPasswordResetCode(email, code) {
  const transporter = getTransporter();

  if (!transporter) {
    logger.warn(`📧 E-mail de recuperação NÃO enviado: SMTP não configurado. Destino: ${safeEmail(email)}`);
    // Em desenvolvimento/sem SMTP, o fluxo continua (código existe no banco).
    // NUNCA logamos o código.
    throw new Error('SMTP_NOT_CONFIGURED');
  }

  const resetUrl = buildResetUrl(email);
  const { subject, text, html } = buildPasswordResetEmail(code, resetUrl);

  try {
    const info = await transporter.sendMail({
      from: config.smtp.from || config.smtp.user,
      to: email,
      subject,
      text,
      html,
    });
    logger.info(`📧 E-mail de recuperação enviado: ${safeEmail(email)} | messageId=${info && info.messageId ? info.messageId : 'n/a'}`);
    return { messageId: info && info.messageId ? info.messageId : null };
  } catch (err) {
    logger.warn(`📧 Falha ao enviar e-mail de recuperação (${safeEmail(email)}): ${err && err.message}`);
    // Erro genérico: sem host, sem credenciais, sem stack no estilo "SMTP auth failed".
    throw new Error('SMTP_FAILED');
  }
}

/**
 * Formata o instante do programa para o e-mail de lembrete. O fuso é o da
 * aplicação (config.app.timeZone), injetável em teste; o label deixa explícito
 * qual fuso está sendo exibido (nunca se assume o fuso do leitor).
 */
function formatReminderInstant(startMs, { timeZone = config.app.timeZone || 'America/Sao_Paulo' } = {}) {
  if (!(Number(startMs) > 0)) return '';
  const fmt = new Intl.DateTimeFormat('pt-BR', {
    timeZone,
    weekday: 'long',
    day: '2-digit',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  });
  return fmt.format(new Date(Number(startMs)));
}

function formatTimeZoneLabel(timeZone) {
  const tz = String(timeZone || config.app.timeZone || 'America/Sao_Paulo');
  const map = {
    'America/Sao_Paulo': 'Horário de Brasília',
    'America/Manaus': 'Horário do Amazonas',
    'America/Recife': 'Horário de Brasília',
    'UTC': 'Horário universal (UTC)',
  };
  return map[tz] || `Horário de ${tz.split('/').pop().replace(/_/g, ' ')}`;
}

/**
 * Limpa valor de conteúdo (programa/canal) para e-mail: remove quebras que
 * injetariam cabeçalho no subject e trunca. O template HTML também escapa.
 */
function cleanMailValue(v, max = 120) {
  return String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').trim().slice(0, max);
}

function escapeHtml(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Renderiza o e-mail de lembrete de programação ("Avise-me").
 * Conteúdo vindo de EPG/M3U é saneado (quebras fora, HTML escapado) — nunca
 * é interpolado cru no subject nem no corpo (prevenção de header/HTML injection).
 * @param {object} opts
 * @param {string} opts.channelName      nome público do canal na M3U
 * @param {string} opts.programTitle     título do programa
 * @param {number} opts.startsAt         timestamp (ms) do início
 * @param {number|null} [opts.stopAt]    timestamp (ms) do fim
 * @param {string}  [opts.appUrl]        URL pública (link opcional para /guia)
 * @param {string}  [opts.timeZone]      fuso da exibição (padrão config.app.timeZone)
 * @returns {{ subject: string, text: string, html: string }}
 */
function buildReminderEmail(opts = {}) {
  const channelName = cleanMailValue(opts.channelName || 'o canal');
  const programTitle = cleanMailValue(opts.programTitle || 'Seu programa');
  const when = formatReminderInstant(opts.startsAt, opts);
  const tzLabel = formatTimeZoneLabel(opts.timeZone);
  const appUrl = cleanMailValue(opts.appUrl, 254);
  const openers = [
    `Olá!`,
    ``,
    `Está na hora do seu programa começar na ${channelName}:`,
    ``,
    `  Programa:  ${programTitle}`,
    `  Canal:     ${channelName}`,
    `  Quando:    ${when} (${tzLabel})`,
    ``,
  ];

  let text = openers.join('\n');

  if (appUrl) {
    text += `\nAssista ao vivo pelo site:\n${appUrl}/guia\n\n`;
  } else {
    text += `\nAbra o site e assista ao vivo pela grade do guia.\n\n`;
  }

  text += `Este aviso foi agendado porque você ativou o "Avise-me" para este programa.`;

  const linkHtml = appUrl
    ? `<a href="${escapeHtml(appUrl)}/guia" style="display:inline-block;padding:13px 28px;background:#22d3ee;color:#0a0f14;text-decoration:none;font-weight:700;font-size:14px;border-radius:10px;">Assistir ao vivo</a>`
    : '';

  const html = `
  <!DOCTYPE html>
  <html lang="pt-BR">
  <body style="margin:0;padding:0;background:#0a0f14;font-family:Inter,Arial,sans-serif;color:#e6edf3;">
    <div style="max-width:520px;margin:0 auto;padding:32px 16px;">
      <div style="text-align:center;padding:24px;background:#111820;border:1px solid #22303a;border-radius:16px;">
        <div style="font-size:22px;font-weight:800;letter-spacing:-0.02em;color:#e6edf3;">
          Sven<span style="color:#22d3ee;">TV</span>
        </div>
        <h1 style="font-size:18px;margin:18px 0 6px;color:#e6edf3;">Lembrete de programação</h1>
        <p style="font-size:14px;color:#8aa0ae;margin:0 0 20px;">
          Seu programa começa em instantes.
        </p>

        <div style="padding:16px;background:#0a0f14;border:1px dashed #22d3ee;border-radius:12px;text-align:left;">
          <div style="font-size:17px;font-weight:700;color:#e6edf3;margin-bottom:6px;">${escapeHtml(programTitle)}</div>
          <div style="font-size:13px;color:#8aa0ae;line-height:1.7;">
            Canal: <span style="color:#c9d6de;">${escapeHtml(channelName)}</span><br>
            Quando: <span style="color:#c9d6de;">${escapeHtml(when)} (${escapeHtml(tzLabel)})</span>
          </div>
        </div>

        ${linkHtml ? `<div style="margin:20px 0 0;">${linkHtml}</div>` : ''}

        <p style="font-size:12px;color:#5c6f7c;margin:20px 0 0;line-height:1.6;">
          Este aviso foi agendado porque você ativou o "Avise-me" para este
          programa. Para desativar, remova o lembrete na área do guia.
        </p>
      </div>
      <p style="text-align:center;font-size:11px;color:#5c6f7c;margin-top:18px;">
        ${PLATFORM_NAME} · API de Streaming · São Paulo, Brasil
      </p>
    </div>
  </body>
  </html>`;

  return { subject: `${PLATFORM_NAME} — ${programTitle} começa agora`, text, html };
}

/**
 * Envia o lembrete de programação por e-mail (cron).
 * NUNCA vaza o motivo técnico da falha para o chamador (erro genérico);
 * o caller decide o que mostrar. Sem SMTP configurado → SMTP_NOT_CONFIGURED
 * (o cron não marca `notifiedAt` e re-tenta na próxima execução).
 * @throws {Error} genérico ("SMTP_FAILED" / "SMTP_NOT_CONFIGURED")
 */
async function sendReminderEmail({ email, channelName, programTitle, startsAt, stopAt }) {
  const transporter = getTransporter();

  if (!transporter) {
    logger.warn(`📧 Lembrete NÃO enviado: SMTP não configurado. Destino: ${safeEmail(email)}`);
    throw new Error('SMTP_NOT_CONFIGURED');
  }

  const { subject, text, html } = buildReminderEmail({
    channelName,
    programTitle,
    startsAt,
    stopAt,
    appUrl: config.app.baseUrl,
  });

  try {
    const info = await transporter.sendMail({
      from: config.smtp.from || config.smtp.user,
      to: email,
      subject,
      text,
      html,
    });
    logger.info(`📧 Lembrete enviado: ${safeEmail(email)} | messageId=${info && info.messageId ? info.messageId : 'n/a'}`);
    return { messageId: info && info.messageId ? info.messageId : null };
  } catch (err) {
    logger.warn(`📧 Falha ao enviar lembrete (${safeEmail(email)}): ${err && err.message}`);
    throw new Error('SMTP_FAILED');
  }
}

/**
 * Loga o e-mail de forma protegida (evita echo de cabeçalhos maliciosos).
 */
function safeEmail(email) {
  return String(email || '').replace(/[\r\n]/g, '').slice(0, 254);
}

module.exports = {
  sendPasswordResetCode,
  sendReminderEmail,
  buildPasswordResetEmail,
  buildReminderEmail,
  buildResetUrl,
  getTransporter,
  _setTransporter,
};