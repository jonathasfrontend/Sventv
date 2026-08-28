'use strict';

/**
 * Serviço de trilha de auditoria.
 *
 * Grava operações sensíveis (login, logout, troca de senha, API token,
 * acesso admin, emissão de playback) em `audit_logs`. Nunca persiste
 * tokens/segredos senão pelos identificadores já auditáveis.
 *
 * Em serverless, a gravação é fire-and-forget: NUNCA bloqueia a resposta
 * da requisição e NUNCA derruba o request por falha de escrita. A tabela
 * não tem FK para usuário (overvive à exclusão).
 */

const logger = require('../utils/logger');

let prisma = null;
try {
  prisma = require('../prisma/client');
} catch (_) {
  // Cold start sem banco ainda — audit apenas em memória/log.
}

/**
 * Registra um evento de auditoria de forma não-bloqueante.
 *
 * @param {object} opts
 * @param {string} opts.action        ação normalizada (ex.: 'auth.login')
 * @param {object} [opts.req]         objeto Express (extrai ip/ua/requestId)
 * @param {string} [opts.userId]
 * @param {string} [opts.email]
 * @param {string} [opts.channelId]
 * @param {object} [opts.meta]        dados extra (SANITIZADOS pelo chamador)
 */
function audit(opts) {
  const { action } = opts;
  if (!action) return;

  const req = opts.req || {};
  const entry = {
    action,
    userId: opts.userId || null,
    email: opts.email || null,
    ip: sanitizeIp(req.ip),
    userAgent: String(req.headers?.['user-agent'] || '').slice(0, 512) || null,
    requestId: req.id || req.requestId || null,
    channelId: opts.channelId || null,
    meta: opts.meta || undefined,
  };

  // Log local sempre (correlação via requestId).
  logger.info(`AUDIT ${action}`, { userId: entry.userId, ip: entry.ip, requestId: entry.requestId });

  if (!prisma || !prisma.auditLog) return;

  prisma.auditLog
    .create({ data: entry })
    .catch((err) => {
      logger.warn(`AUDIT falhou ao persistir (${action}): ${err.message}`);
    });
}

function sanitizeIp(ip) {
  if (!ip) return null;
  const s = String(ip);
  if (s === '::1' || s === '::ffff:127.0.0.1') return '127.0.0.1';
  return s.slice(0, 64) || null;
}

module.exports = { audit, sanitizeIp };
