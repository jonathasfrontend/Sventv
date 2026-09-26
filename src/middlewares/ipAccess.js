/**
 * SvenTV API — Middleware de IP Access Control (blocklist WAF)
 *
 * Aplica a blocklist persistente de IPs (ip_access) ANTES de qualquer rota
 * — cobre páginas web (login/register incluídos) e /api. Comportamento:
 *   - IP com registro ativo em `ip_blocklist` → 403 imediato;
 *   - fail-open: banco/cache indisponível NÃO derruba o fluxo (a autenticação
 *     segue como barreira primária);
 *   - endpoints de saúde e assets estáticos continuam acessíveis (não são
 *     superfície sensível e evitam buckets de query por GET);
 *   - NUNCA audita por requisição (evita flood no audit_logs): a decisão é
 *     métrica + log; a trilha administrativa vem da ação do admin.
 */

'use strict';

const IpBlocklistService = require('../services/ipBlocklistService');
const { getClientIp } = require('../utils/ipAddress');
const { inc } = require('../utils/metrics');
const logger = require('../utils/logger');

const SERVICE = IpBlocklistService.getShared();

// Prefixos que permanecem acessíveis a IPs bloqueados: health check e assets
// estáticos (CSS/JS/Player/fontes) não são superfície sensível — bloqueá-los
// só aumentaria o custo de query por GET estático.
const STATIC_PREFIXES = ['/css/', '/js/', '/img/', '/images/', '/fonts/', '/Player/', '/vendor/'];
const ALWAYS_ALLOWED = new Set(['/favicon.ico', '/api/health']);

function isSkippable(req) {
  const path = req.path || req.url || '';
  if (ALWAYS_ALLOWED.has(path)) return true;
  if (path.startsWith('/api/health') || path === '/api/health') return true;
  for (const prefix of STATIC_PREFIXES) {
    if (path.startsWith(prefix)) return true;
  }
  return false;
}

function blockResponse(req, res) {
  inc('ipAccessBlocked');
  logger.warn(`[ipAccess] IP bloqueado: ${req.ip} (${req.method} ${req.originalUrl || req.url})`, {
    requestId: req.id,
  });
  if (req.path && req.path.startsWith('/api/')) {
    return res.status(403).json({ success: false, message: 'Acesso negado.' });
  }
  // Página (login/register/perfil...): resposta mínima, sem detalhes internos.
  res.status(403);
  res.setHeader('Cache-Control', 'no-store');
  return res.send(
    '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">' +
      '<meta name="robots" content="noindex,nofollow">' +
      '<title>Acesso negado</title></head><body>' +
      '<main style="font-family:system-ui,sans-serif;max-width:480px;margin:80px auto;padding:0 20px;text-align:center">' +
      '<h1 style="font-size:20px">Acesso negado</h1>' +
      '<p style="color:#666">Não foi possível concluir sua solicitação.</p>' +
      '</main></body></html>'
  );
}

const ipAccess = async (req, res, next) => {
  try {
    if (isSkippable(req)) return next();
    const ip = getClientIp(req);
    const blocked = ip ? await SERVICE.isBlocked(ip) : false;
    if (!blocked) return next();
    return blockResponse(req, res);
  } catch (_) {
    // Fail-open: qualquer erro interno do gate não derruba o request.
    return next();
  }
};

module.exports = { ipAccess, isSkippable, blockResponse };