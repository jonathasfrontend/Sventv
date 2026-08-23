/**
 * SvenTV API - Middlewares de Segurança
 *
 * Pacote de proteções avançadas contra:
 *  - Payload injection por chaves maliciosas
 *  - XSS (sanitização manual de strings)
 *  - Hotlinking (proteção de streams)
 *  - Headers de fingerprint (X-Powered-By)
 *  - Payloads suspeitos
 */

'use strict';

const logger = require('../utils/logger');
const config = require('../config/app');

// Rotas de stream/proxy recebem URLs completas via query (?u=...) e não
// as refletem na resposta sem re-encodar; sanitizar esses valores corrompe
// a URL (ex.: "/" vira "&#x2F;" e new URL() interpreta host="&").
const STREAM_PATH_RE = /^\/api\/channels\/[^/]+\/(?:proxy|stream)(?:\/|$)/;
const isStreamPath = (req) => STREAM_PATH_RE.test(req.path || '');

// ─────────────────────────────────────────────────────────────
// Payload Injection Prevention
// ─────────────────────────────────────────────────────────────

/**
 * Remove chaves potencialmente perigosas de req.body, req.query e req.params.
 * Deve ser aplicado ANTES de qualquer controller.
 */
const sanitizeObjectKeys = (input, req) => {
  if (Array.isArray(input)) {
    return input.map((item) => sanitizeObjectKeys(item, req));
  }

  if (!input || typeof input !== 'object') {
    return input;
  }

  const sanitized = {};

  for (const [rawKey, rawValue] of Object.entries(input)) {
    const safeKey = rawKey.replace(/\$/g, '').replace(/\./g, '_');

    if (safeKey !== rawKey) {
      logger.warn(`🚨 Payload suspeito sanitizado: IP=${req.ip} | Campo=${rawKey}`);
    }

    sanitized[safeKey] = sanitizeObjectKeys(rawValue, req);
  }

  return sanitized;
};

const sanitizeMongo = (req, _res, next) => {
  if (isStreamPath(req)) return next();
  if (req.body) req.body = sanitizeObjectKeys(req.body, req);
  if (req.query) req.query = sanitizeObjectKeys(req.query, req);
  if (req.params) req.params = sanitizeObjectKeys(req.params, req);
  next();
};

// ─────────────────────────────────────────────────────────────
// XSS Prevention (sanitização de strings)
// ─────────────────────────────────────────────────────────────

/**
 * Escapa caracteres HTML perigosos em strings recursivamente.
 * @param {*} value
 * @returns {*}
 */
const escapeHtml = (value) => {
  if (typeof value === 'string') {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;')
      .replace(/\//g, '&#x2F;');
  }
  if (typeof value === 'object' && value !== null) {
    if (Array.isArray(value)) {
      return value.map(escapeHtml);
    }
    const sanitized = {};
    for (const key of Object.keys(value)) {
      sanitized[key] = escapeHtml(value[key]);
    }
    return sanitized;
  }
  return value;
};

/**
 * Middleware XSS: sanitiza req.body e req.query.
 */
const sanitizeXss = (req, _res, next) => {
  if (isStreamPath(req)) return next();
  if (req.body) req.body = escapeHtml(req.body);
  if (req.query) req.query = escapeHtml(req.query);
  next();
};

// ─────────────────────────────────────────────────────────────
// Proteção anti-hotlinking para streams
// ─────────────────────────────────────────────────────────────

/**
 * Bloqueia acesso direto a streams sem Referer válido ou token de API.
 * Deve ser aplicado nas rotas /stream/:id.
 */
const antiHotlink = (req, res, next) => {
  const referer = req.headers.referer || req.headers.origin || '';
  const hasToken =
    (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) ||
    req.query.token;

  // Se tem token válido, libera
  if (hasToken) return next();

  // Verifica referers permitidos
  const allowedOrigins = config.cors.origins;
  const isAllowed =
    allowedOrigins.includes('*') ||
    allowedOrigins.some((origin) => referer.startsWith(origin));

  if (!isAllowed && referer) {
    logger.warn(`🚫 Hotlink bloqueado: referer=${referer} | IP=${req.ip}`);
    return res.status(403).json({
      success: false,
      message: 'Acesso direto ao stream não é permitido. Use o player oficial.',
    });
  }

  next();
};

// ─────────────────────────────────────────────────────────────
// Remover header X-Powered-By (fingerprint do servidor)
// ─────────────────────────────────────────────────────────────

/**
 * Remove headers que identificam a tecnologia do servidor.
 */
const removeFingerprint = (_req, res, next) => {
  res.removeHeader('X-Powered-By');
  res.removeHeader('Server');
  next();
};

// ─────────────────────────────────────────────────────────────
// Logger de segurança para requests suspeitos
// ─────────────────────────────────────────────────────────────

/**
 * Detecta e loga padrões suspeitos nas requisições.
 */
const securityLogger = (req, _res, next) => {
  const suspicious = [
    /(\.\.|\/etc\/passwd|\/etc\/shadow)/i,       // Path traversal
    /(union\s+select|drop\s+table|insert\s+into)/i, // SQL Injection básico
    /(<script|javascript:|data:text\/html)/i,    // XSS
    /(\$where|\$regex|\$gt|\$lt)/,               // NoSQL Injection residual
  ];

  const urlToCheck = req.originalUrl + JSON.stringify(req.body || '');

  for (const pattern of suspicious) {
    if (pattern.test(urlToCheck)) {
      logger.warn(
        `🚨 Request suspeito detectado: IP=${req.ip} | Método=${req.method} | URL=${req.originalUrl}`
      );
      break;
    }
  }

  next();
};

module.exports = {
  sanitizeMongo,
  sanitizeXss,
  antiHotlink,
  removeFingerprint,
  securityLogger,
};
