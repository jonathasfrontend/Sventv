/**
 * SvenTV API — Serviço de Alertas Operacionais (notificação ao admin)
 *
 * Eventos operacionais relevantes são notificados de forma ASSÍNCRONA e
 * FIRE-AND-FORGET (nunca bloqueiam nem derrubam o fluxo principal):
 *   - channelHealth.failover / channelHealth.failback  (troca de fonte)
 *   - email.smtp_failure    (falha de envio transacional)
 *   - redis.memory_fallback (Redis fora → fallback em memória)
 *
 * Canais de entrega (ambos opcionais):
 *   - e-mail → ADMIN_ALERT_EMAIL (HTML com design + fallback texto, via
 *     transporter SMTP existente);
 *   - webhook → ALERT_WEBHOOK_URL (payload {text} p/ Slack/genéricos;
 *     {content}+{embeds} rico p/ webhooks do Discord — {text} no Discord
 *     leva a HTTP 400 "cannot send an empty message"; shape por host+path,
 *     título/cor/fields por evento em EVENT_META).
 *
 * Defesas/garantias:
 *   - A URL do webhook é SEGREDO: nunca é logada nem exposta;
 *   - NENHUM detalhe sensível é logado (nem endereço de host de SMTP no
 *     erro); apenas o eventKey aparece nos logs;
 *   - Debounce por evento (ALERT_COOLDOWN_MS) e por lambda — limitação
 *     documentada: serverless não possui timer único global;
 *   - Falha de entrega é logada e contada (alertsFailed), nunca rethrow.
 *
 * Testabilidade: `_setSinks()` emula os canais de entrega (sem SMTP/rede).
 */

'use strict';

const axios = require('axios');

const config = require('../config/app');
const emailService = require('./emailService');
const logger = require('../utils/logger');
const { inc } = require('../utils/metrics');

const PLATFORM = 'SvenTV';

// Emenda de teste: substitui os canais de entrega reais.
let _sinks = null;

// Instante (ms) do último envio por eventKey — debounce por lambda.
const _lastSentAt = new Map();

/**
 * Sanitiza um valor para mensagem (sem quebras de linha/controles, com teto).
 */
function _clean(value, max = 500) {
  const s = String(value === null || value === undefined
    ? ''
    : (typeof value === 'object' ? JSON.stringify(value) : value));
  return s.replace(/[\r\n]/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max);
}

function _debounced(eventKey) {
  const now = Date.now();
  const last = _lastSentAt.get(eventKey) || 0;
  if (now - last < config.alerts.cooldownMs) {
    inc('alertsDebounced');
    return true;
  }
  _lastSentAt.set(eventKey, now);
  return false;
}

/**
 * Metadados de apresentação por evento: título legível, emoji, cor (email +
 * embed do Discord) e categoria. Adicione entradas aqui para personalizar a
 * mensagem — eventos sem entrada usam DEFAULT_META (🔔 / roxo / sistema).
 */
const EVENT_META = {
  'auth.user_registered': { title: 'Novo usuário registrado', emoji: '👤', hex: '#16a34a', category: 'usuário' },
  'auth.account_locked': { title: 'Conta bloqueada por tentativas', emoji: '🔒', hex: '#e67e22', category: 'usuário' },
  'auth.password_reset_attempts_exceeded': { title: 'Tentativas de reset excedidas', emoji: '⚠️', hex: '#e67e22', category: 'usuário' },
  'auth.register_rate_limited': { title: 'Rate limit de registro atingido', emoji: '🛡️', hex: '#dc2626', category: 'segurança' },
  'admin.role_escalation': { title: 'Usuário promovido a admin', emoji: '🚨', hex: '#dc2626', category: 'segurança' },
  'admin.user_deleted': { title: 'Usuário excluído', emoji: '🗑️', hex: '#dc2626', category: 'segurança' },
  'channelHealth.failover': { title: 'Failover de canal', emoji: '🔁', hex: '#2563eb', category: 'infra' },
  'channelHealth.failback': { title: 'Failback de canal', emoji: '✅', hex: '#16a34a', category: 'infra' },
  'email.smtp_failure': { title: 'Falha no envio de e-mail', emoji: '📧', hex: '#dc2626', category: 'infra' },
  'redis.memory_fallback': { title: 'Redis fora — fallback em memória', emoji: '🔴', hex: '#e67e22', category: 'infra' },
};
const DEFAULT_META = { title: 'Evento operacional', emoji: '🔔', hex: '#7c3aed', category: 'sistema' };

/** Rótulos amigáveis das chaves de `details` (fallback: humaniza camelCase). */
const FIELD_LABELS = {
  userId: 'Usuário (ID)',
  targetUserId: 'Usuário alvo (ID)',
  changedBy: 'Executado por',
  deletedBy: 'Excluído por',
  email: 'E-mail',
  targetEmail: 'E-mail do alvo',
  name: 'Nome',
  createdAt: 'Criado em',
  lockUntil: 'Bloqueado até',
  attempts: 'Tentativas',
  ip: 'IP de origem',
  channelName: 'Canal',
  source: 'Fonte',
  error: 'Erro',
  status: 'Status',
  dimension: 'Dimensão',
  activeLimit: 'Limite ativo',
};

function _eventMeta(eventKey) {
  const base = String(eventKey || '').split(':')[0];
  return EVENT_META[base] || DEFAULT_META;
}

function _escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

function _hexToDiscordColor(hex) {
  const n = parseInt(String(hex).replace('#', ''), 16);
  return Number.isFinite(n) ? n : 0x7c3aed;
}

function _humanizeKey(key) {
  if (FIELD_LABELS[key]) return FIELD_LABELS[key];
  return String(key)
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/^./, (c) => c.toUpperCase());
}

/** Converte `details` em linhas {label, value} (SEM segredos já no call-site). */
function _detailsEntries(details) {
  const list = [];
  if (details && typeof details === 'object' && !Array.isArray(details)) {
    for (const [k, v] of Object.entries(details)) {
      if (v === null || v === undefined) continue;
      list.push({ key: k, label: _humanizeKey(k), value: _clean(v, 1000) });
    }
  }
  return list.slice(0, 24);
}

/**
 * Corpo HTML do e-mail de alerta (layout em tabela p/ clientes de e-mail,
 * estilos inline, todos os valores dinâmicos escapados).
 */
function _buildEmailHtml(meta, eventKey, entries, text) {
  const rows = entries.length
    ? entries.map(({ label, value }) =>
        `<tr>
          <td style="padding:8px 16px;font-size:13px;color:#64748b;white-space:nowrap;vertical-align:top;border-bottom:1px solid #e2e8f0;">${_escapeHtml(label)}</td>
          <td style="padding:8px 16px;font-size:13px;color:#0f172a;vertical-align:top;border-bottom:1px solid #e2e8f0;word-break:break-word;">${_escapeHtml(value)}</td>
        </tr>`)
      .join('')
    : '<tr><td colspan="2" style="padding:8px 16px;font-size:13px;color:#64748b;">Sem detalhes adicionais.</td></tr>';

  return `<!doctype html>
<html>
  <head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /></head>
  <body style="margin:0;padding:0;background-color:#f1f5f9;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f1f5f9;">
      <tr>
        <td align="center" style="padding:32px 16px;">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0;">
            <tr><td height="6" style="height:6px;background-color:${meta.hex};font-size:0;line-height:0;">&nbsp;</td></tr>
            <tr>
              <td style="padding:24px 28px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="font-size:18px;font-weight:700;color:#0f172a;">Sven<span style="color:${meta.hex};">TV</span></td>
                    <td align="right" style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#94a3b8;">Alerta operacional</td>
                  </tr>
                </table>
                <div style="margin-top:18px;display:inline-block;padding:6px 14px;border-radius:999px;font-size:12px;font-weight:600;color:#ffffff;background-color:${meta.hex};">${meta.emoji} ${_escapeHtml(meta.title)}</div>
                <p style="margin-top:16px;font-size:13px;color:#334155;line-height:1.5;">Evento:
                  <code style="background-color:#f1f5f9;border-radius:4px;padding:2px 6px;font-size:12px;color:${meta.hex};">${_escapeHtml(eventKey)}</code>
                </p>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">
                  ${rows}
                </table>
                <p style="margin-top:18px;font-size:11px;color:#94a3b8;line-height:1.5;">Mensagem original:<br /><span style="color:#64748b;">${_escapeHtml(text)}</span></p>
              </td>
            </tr>
            <tr>
              <td style="padding:14px 28px;background-color:#f8fafc;border-top:1px solid #e2e8f0;font-size:11px;color:#94a3b8;">${_escapeHtml(PLATFORM)} API · Categoria: ${_escapeHtml(meta.category)} · ${_escapeHtml(new Date().toISOString())}</td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

/** Embed rico (Discord) — título, cor por evento, campos rotulados e timestamp. */
function _buildDiscordEmbed(meta, eventKey, entries) {
  const fields = entries.slice(0, 23).map(({ label, value }) => ({
    name: label.slice(0, 256),
    value: `\`${String(value).slice(0, 1000)}\``,
    inline: false,
  }));
  return {
    title: `${meta.emoji} ${meta.title}`,
    color: _hexToDiscordColor(meta.hex),
    description: `**Evento:** \`${eventKey}\``,
    fields,
    footer: { text: `${PLATFORM} API · ${meta.category}` },
    timestamp: new Date().toISOString(),
  };
}

/**
 * Escolhe o shape do payload do webhook:
 *   - Discord (host discord.com/discordapp.com + path /api/webhooks/*) →
 *     { content, embeds } com embed rico;
 *   - Slack e genéricos → { text } (retrocompatível).
 * Detalhes em `{text}` no Discord dão HTTP 400 ("cannot send an empty
 * message") — o motivo real do "Alerta webhook falhou" sem erro de rede.
 */
function _webhookPayloadFor(text, eventKey, details, webhookUrl) {
  let parsed;
  try {
    parsed = new URL(String(webhookUrl || '').trim());
  } catch {
    parsed = null;
  }
  const host = (parsed && parsed.hostname) || '';
  if (host === 'discord.com' || host === 'discordapp.com') {
    if (parsed && (parsed.pathname || '').startsWith('/api/webhooks/')) {
      const meta = _eventMeta(eventKey);
      return {
        content: `${meta.emoji} ${meta.title} — ${_clean(eventKey, 60)}`,
        embeds: [_buildDiscordEmbed(meta, eventKey, _detailsEntries(details))],
      };
    }
  }
  return { text };
}

async function _sendWebhook(text, payload) {
  const url = String(config.alerts.webhookUrl || '').trim();
  if (!url) return false;
  await axios.post(url, payload, {
    timeout: 10_000,
    maxRedirects: 0,
    headers: { 'Content-Type': 'application/json' },
  });
  return true;
}

async function _sendEmail(subject, text, html) {
  const to = String(config.alerts.adminEmail || '').trim();
  if (!to) return false;
  const transporter = emailService.getTransporter();
  if (!transporter) return false;
  await transporter.sendMail({
    from: config.smtp.from || config.smtp.user,
    to,
    subject,
    text,
    html,
  });
  return true;
}

/**
 * Envia um alerta operacional (fire-and-forget).
 * @param {string} eventKey  identificador estável do evento
 * @param {object} [details] dados contextuais (SEM segredos — só ids/nomes)
 */
function notify(eventKey, details) {
  if (!config.alerts.enabled) return;
  if (typeof eventKey !== 'string' || !eventKey) return;
  if (_debounced(eventKey)) return;

  const meta = _eventMeta(eventKey);
  const entries = _detailsEntries(details);
  const subject = `${PLATFORM} — Alerta: ${meta.emoji} ${meta.title}`;
  const text = `${_clean(eventKey, 80)}\n${_clean(details, 2000)}`;
  const html = _buildEmailHtml(meta, eventKey, entries, text);
  const payload = _webhookPayloadFor(text, eventKey, details, config.alerts.webhookUrl);

  const safeKey = _clean(eventKey, 60);
  const jobs = [];

  if (_sinks) {
    if (_sinks.sendEmail) jobs.push(Promise.resolve().then(() => _sinks.sendEmail({ subject, text, html })));
    if (_sinks.sendWebhook) jobs.push(Promise.resolve().then(() => _sinks.sendWebhook(text, payload)));
  } else {
    if (String(config.alerts.adminEmail || '').trim()) {
      jobs.push(
        _sendEmail(subject, text, html).catch(() => {
          inc('alertsFailed');
          logger.warn(`Alerta e-mail falhou (${safeKey})`);
          return false;
        })
      );
    }
    if (String(config.alerts.webhookUrl || '').trim()) {
      jobs.push(
        _sendWebhook(text, payload).catch((err) => {
          inc('alertsFailed');
          const status = err && err.response ? err.response.status : null;
          logger.warn(`Alerta webhook falhou (${safeKey})${status ? ` — HTTP ${status}` : ''}`);
          return false;
        })
      );
    }
  }

  inc('alertsSent');
  logger.info(`Alerta operacional (${safeKey})`);
  Promise.all(jobs).catch(() => {});
}

/**
 * Apenas para testes: limpa o debounce interno.
 */
function resetCooldown() {
  _lastSentAt.clear();
}

/**
 * Apenas para testes: injeta os canais de entrega. Pass null para voltar
 * ao comportamento real (SMTP/webhook).
 */
function _setSinks(sinks) {
  _sinks = sinks || null;
}

module.exports = { notify, resetCooldown, _setSinks, _webhookPayloadFor };