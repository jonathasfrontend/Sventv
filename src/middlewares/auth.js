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

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

/**
 * Extrai o Bearer token do header Authorization ou query string.
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
 * Protege rotas da API (channels, stream, etc.).
 * Aceita o API token JWT exclusivo de cada usuário.
 * Injeta `req.user` e `req.apiUser`.
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

    // Verifica assinatura do API token
    let decoded;
    try {
      decoded = jwt.verify(token, config.jwtApi.secret);
    } catch (err) {
      const msg =
        err.name === 'TokenExpiredError'
          ? 'Token de API expirado. Regenere em /auth/profile.'
          : 'Token de API inválido.';
      return res.status(401).json({ success: false, message: msg });
    }

    // Garante que é um token do tipo 'api'
    if (decoded.type !== 'api') {
      return res.status(401).json({
        success: false,
        message: 'Tipo de token inválido para esta rota.',
      });
    }

    // Busca o usuário e confirma que o token ainda pertence a ele
    const user = await User.findByIdWithSensitive(decoded.id);

    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'Usuário do token não encontrado.',
      });
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
        message: 'Token de API desativado. Regularize o pagamento para reativar.',
      });
    }

    if (typeof decoded.tv === 'number' && decoded.tv !== (user.apiTokenVersion || 0)) {
      return res.status(401).json({
        success: false,
        message: 'Token de API revogado por alteracao de seguranca.',
      });
    }

    // Confirma que o token fornecido é exatamente o token atual do usuário
    if (user.apiToken !== token) {
      return res.status(401).json({
        success: false,
        message: 'Token de API revogado ou substituído. Regenere em /auth/profile.',
      });
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
  requireRole,
};
