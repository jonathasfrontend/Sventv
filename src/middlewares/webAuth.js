'use strict';
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const config = require('../config/app');
const logger = require('../utils/logger');

/**
 * Tenta resolver o usuário a partir do sessionToken (cookie ou header).
 * Caso não esteja autenticado, apenas seta req.user = null (sem bloquear).
 * Útil para páginas públicas que precisam saber se o usuário está logado.
 */
async function resolveUser(req, res, next) {
  try {
    // Prioridade: cookie > Authorization header > header x-session-token
    const token =
      req.cookies?.sessionToken ||
      (req.headers.authorization?.startsWith('Bearer ')
        ? req.headers.authorization.slice(7)
        : null) ||
      req.headers['x-session-token'] ||
      null;

    if (!token) {
      req.user = null;
      return next();
    }

    const decoded = jwt.verify(token, config.jwt.secret);
    const user = await User.findById(decoded.id);

    if (!user || user.status === 'banned' || user.status === 'inactive') {
      req.user = null;
      return next();
    }

    req.user = user;
    res.locals.user = user;
  } catch (err) {
    // Token inválido/expirado — trata como não autenticado
    req.user = null;
  }
  return next();
}

/**
 * Middleware de proteção: exige sessão ativa.
 * Se não autenticado, redireciona para /login.
 */
async function requireWebAuth(req, res, next) {
  await resolveUser(req, res, () => {});
  if (!req.user) {
    const returnTo = encodeURIComponent(req.originalUrl);
    return res.redirect(`/login?returnTo=${returnTo}`);
  }
  return next();
}

/**
 * Middleware para páginas de auth (login/register):
 * Se já estiver autenticado, redireciona para /dashboard.
 */
async function redirectIfAuthenticated(req, res, next) {
  await resolveUser(req, res, () => {});
  if (req.user) {
    return res.redirect('/dashboard');
  }
  return next();
}

/**
 * Middleware para páginas web protegidas por role.
 * Redireciona usuários sem permissão para a dashboard.
 */
function requireWebRole(...roles) {
  return async (req, res, next) => {
    await resolveUser(req, res, () => {});
    if (!req.user) {
      return res.redirect(`/login?returnTo=${encodeURIComponent(req.originalUrl)}`);
    }
    if (!roles.includes(req.user.role)) {
      req.session = req.session || {};
      if (req.session) {
        req.session.flash = { type: 'error', message: 'Acesso restrito ao painel administrativo.' };
      }
      return res.redirect('/dashboard');
    }
    return next();
  };
}

module.exports = { resolveUser, requireWebAuth, redirectIfAuthenticated, requireWebRole };
