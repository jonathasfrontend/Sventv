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
 *   - e-mail → ADMIN_ALERT_EMAIL (via transporter SMTP existente)
 *   - webhook → ALERT_WEBHOOK_URL (payload {text}, compatível Slack/Discord)
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

async function _sendWebhook(text) {
  const url = String(config.alerts.webhookUrl || '').trim();
  if (!url) return false;
  await axios.post(url, { text }, {
    timeout: 10_000,
    maxRedirects: 0,
    headers: { 'Content-Type': 'application/json' },
  });
  return true;
}

async function _sendEmail(subject, text) {
  const to = String(config.alerts.adminEmail || '').trim();
  if (!to) return false;
  const transporter = emailService.getTransporter();
  if (!transporter) return false;
  await transporter.sendMail({
    from: config.smtp.from || config.smtp.user,
    to,
    subject,
    text,
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

  const subject = `${PLATFORM} — Alerta: ${_clean(eventKey, 60)}`;
  const text = `${_clean(eventKey, 80)}\n${_clean(details, 2000)}`;

  const safeKey = _clean(eventKey, 60);
  const jobs = [];

  if (_sinks) {
    if (_sinks.sendEmail) jobs.push(Promise.resolve().then(() => _sinks.sendEmail({ subject, text })));
    if (_sinks.sendWebhook) jobs.push(Promise.resolve().then(() => _sinks.sendWebhook(text)));
  } else {
    if (String(config.alerts.adminEmail || '').trim()) {
      jobs.push(
        _sendEmail(subject, text).catch(() => {
          inc('alertsFailed');
          logger.warn(`Alerta e-mail falhou (${safeKey})`);
          return false;
        })
      );
    }
    if (String(config.alerts.webhookUrl || '').trim()) {
      jobs.push(
        _sendWebhook(text).catch(() => {
          inc('alertsFailed');
          logger.warn(`Alerta webhook falhou (${safeKey})`);
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

module.exports = { notify, resetCooldown, _setSinks };