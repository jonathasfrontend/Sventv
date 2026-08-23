/**
 * SvenTV API - Middleware de Autenticação JWT
 *
 * Suporta dois modos de autenticação:
 *  1. Session Token  → Bearer JWT no header Authorization (login do painel)
 *  2. API Token      → Bearer JWT no header Authorization ou query ?token=
 *
 * O middleware verifica a assinatura, expiração e status do usuário.
 */

'use strict';

const jwt = require('jsonwebtoken');
const User = require('../models/User');
const config = require('../config/app');
const logger = require('../utils/logger');
const { isDatabaseConnected } = require('../utils/dbState');
const { verifyPlaybackToken } = require('../services/streamTokenService');

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

/**
 * Extrai o Bearer token do header Authorization, query string ou
 * cookie httpOnly de sessão (fallback para páginas do painel).
 * @param {import('express').Request} req
 * @returns {string|null}
 */
const extractToken = (req) => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  if (req.query && req.query.token) {
    return req.query.token;
  }
  // Cookie httpOnly emitido no login (mesma origem envia automaticamente)
  if (req.cookies && req.cookies.sessionToken) {
    return req.cookies.sessionToken;
  }
  return null;
};

// ─────────────────────────────────────────────────────────────
// Middleware: Sessão (painel/site)
// ─────────────────────────────────────────────────────────────

/**
 * Protege rotas que exigem login no painel (session token).
 * Injeta `req.user` com os dados do usuário autenticado.
 */
const requireSessionAuth = async (req, res, next) => {
  try {
    if (!isDatabaseConnected()) {
      return res.status(503).json({
        success: false,
        message: 'Serviço de autenticação temporariamente indisponível. Tente novamente em instantes.',
      });
    }

    const token = extractToken(req);

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Acesso não autorizado. Token de sessão ausente.',
      });
    }

    // Verifica assinatura e expiração
    let decoded;
    try {
      decoded = jwt.verify(token, config.jwt.secret);
    } catch (err) {
      const msg =
        err.name === 'TokenExpiredError'
          ? 'Sessão expirada. Faça login novamente.'
          : 'Token de sessão inválido.';
      return res.status(401).json({ success: false, message: msg });
    }

    // Busca o usuário no banco
    const user = await User.findById(decoded.id);

    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'Usuário não encontrado.',
      });
    }

    // Revogação server-side: logout/troca de senha incrementam sessionVersion
    if (typeof decoded.sv === 'number' && decoded.sv !== (user.sessionVersion || 0)) {
      return res.status(401).json({
        success: false,
        message: 'Sessão revogada. Faça login novamente.',
      });
    }

    if (user.status !== 'active') {
      return res.status(403).json({
        success: false,
        message: `Conta ${user.status}. Entre em contato com o suporte.`,
      });
    }

    req.user = user;
    next();
  } catch (error) {
    logger.error(`[auth.requireSessionAuth] ${error.message}`);
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────
// Middleware: API Token
// ─────────────────────────────────────────────────────────────

/**
 * Valida um API token e carrega o usuário correspondente.
 * Retorna `{ user }` em caso de sucesso ou `{ error: { status, message } }`.
 * Compartilhado por requireApiAuth e requireStreamAccess.
 * @param {string} token
 */
const validateApiToken = async (token) => {
  // Verifica assinatura do API token
  let decoded;
  try {
    decoded = jwt.verify(token, config.jwtApi.secret);
  } catch (err) {
    const msg =
      err.name === 'TokenExpiredError'
        ? 'Token de API expirado. Regenere em /auth/profile.'
        : 'Token de API inválido.';
    return { error: { status: 401, message: msg } };
  }

  // Garante que é um token do tipo 'api'
  if (decoded.type !== 'api') {
    return { error: { status: 401, message: 'Tipo de token inválido para esta rota.' } };
  }

  // Busca o usuário e confirma que o token ainda pertence a ele
  const user = await User.findByIdWithSensitive(decoded.id);

  if (!user) {
    return { error: { status: 401, message: 'Usuário do token não encontrado.' } };
  }

  if (user.status !== 'active') {
    return {
      error: { status: 403, message: `Conta ${user.status}. Entre em contato com o suporte.` },
    };
  }

  if (user.accountRestricted) {
    return {
      error: {
        status: 403,
        message: user.restrictedReason || 'Conta restrita por pendencia de pagamento.',
      },
    };
  }

  if (user.apiTokenActive === false) {
    return {
      error: {
        status: 401,
        message: 'Token de API desativado. Regularize o pagamento para reativar.',
      },
    };
  }

  if (typeof decoded.tv === 'number' && decoded.tv !== (user.apiTokenVersion || 0)) {
    return {
      error: { status: 401, message: 'Token de API revogado por alteracao de seguranca.' },
    };
  }

  // Confirma que o token fornecido é exatamente o token atual do usuário
  if (user.apiToken !== token) {
    return {
      error: {
        status: 401,
        message: 'Token de API revogado ou substituído. Regenere em /auth/profile.',
      },
    };
  }

  return { user };
};

/**
 * Protege rotas da API (channels, stats, etc.).
 * Aceita apenas o API token JWT exclusivo de cada usuário.
 * Injeta `req.user` e `req.apiToken`.
 */
const requireApiAuth = async (req, res, next) => {
  try {
    if (!isDatabaseConnected()) {
      return res.status(503).json({
        success: false,
        message: 'Serviço de autenticação temporariamente indisponível. Tente novamente em instantes.',
      });
    }

    const token = extractToken(req);

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Token de API obrigatório. Inclua no header: Authorization: Bearer <token>',
        docs: '/api/info',
      });
    }

    const { user, error } = await validateApiToken(token);

    if (error) {
      return res.status(error.status).json({ success: false, message: error.message });
    }

    req.user = user;
    req.apiToken = token;
    next();
  } catch (error) {
    logger.error(`[auth.requireApiAuth] ${error.message}`);
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────
// Middleware: Acesso a Stream (API token OU playback token)
// ─────────────────────────────────────────────────────────────

/**
 * Protege as rotas de reprodução (/stream e /proxy).
 * Aceita:
 *  - API token permanente (compatibilidade com clientes externos da API), ou
 *  - Playback token de curta duração emitido por canal (usado pelo player web).
 *
 * O playback token só vale para o canal gravado nele (claim `ch`), impedindo
 * que um token emitido para um canal seja usado em outro.
 *
 * Injeta `req.user`, `req.authToken` (o token efetivamente usado) e
 * `req.authKind` ('api' | 'playback').
 */
const requireStreamAccess = async (req, res, next) => {
  try {
    if (!isDatabaseConnected()) {
      return res.status(503).json({
        success: false,
        message: 'Serviço de autenticação temporariamente indisponível. Tente novamente em instantes.',
      });
    }

    const token = extractToken(req);

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Token de acesso obrigatório para reprodução.',
        docs: '/api/info',
      });
    }

    // Caminho 1: API token permanente (validação completa, como nas rotas REST)
    const { user: apiUser, error: apiError } = await validateApiToken(token);

    if (!apiError) {
      req.user = apiUser;
      req.authToken = token;
      req.authKind = 'api';
      return next();
    }

    // Caminho 2: playback token curto vinculado a este canal
    const decoded = verifyPlaybackToken(token);

    if (!decoded) {
      return res.status(401).json({
        success: false,
        message: 'Token de acesso ao stream inválido ou expirado.',
      });
    }

    const channelId = req.params.id || req.params.channelId;

    if (!channelId || decoded.ch !== channelId) {
      return res.status(403).json({
        success: false,
        message: 'Playback token não é válido para este canal.',
      });
    }

    const user = await User.findByIdWithSensitive(decoded.id);

    if (!user) {
      return res.status(401).json({ success: false, message: 'Usuário não encontrado.' });
    }

    if (user.status !== 'active') {
      return res.status(403).json({
        success: false,
        message: `Conta ${user.status}. Entre em contato com o suporte.`,
      });
    }

    if (user.accountRestricted) {
      return res.status(403).json({
        success: false,
        message: user.restrictedReason || 'Conta restrita por pendencia de pagamento.',
      });
    }

    if (user.apiTokenActive === false) {
      return res.status(401).json({
        success: false,
        message: 'Acesso à transmissão desativado. Regularize o pagamento para reativar.',
      });
    }

    req.user = user;
    req.authToken = token;
    req.authKind = 'playback';
    next();
  } catch (error) {
    logger.error(`[auth.requireStreamAccess] ${error.message}`);
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────
// Middleware: Autorização por papel (role)
// ─────────────────────────────────────────────────────────────

/**
 * Restringe acesso a papéis específicos.
 * Deve ser usado APÓS requireSessionAuth.
 * @param {...string} roles - Papéis permitidos (ex: 'admin', 'user')
 */
const requireRole = (...roles) => {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: 'Permissão insuficiente para acessar este recurso.',
      });
    }
    next();
  };
};

// ─────────────────────────────────────────────────────────────
// Middleware: Autorização por plano
// ─────────────────────────────────────────────────────────────

module.exports = {
  requireSessionAuth,
  requireApiAuth,
  requireStreamAccess,
  requireRole,
};
