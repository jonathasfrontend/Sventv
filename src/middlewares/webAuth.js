'use strict';
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const config = require('../config/app');
const logger = require('../utils/logger');

async function resolveUser(req, res, next) {
  try {
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

    let decoded;
    try {
      decoded = jwt.verify(token, config.jwt.secret);
    } catch (_) {
      req.user = null;
      return next();
    }

    let user = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        user = await User.findById(decoded.id);
        break;
      } catch (err) {
        if (attempt === 0) {
          logger.warn(`[webAuth.resolveUser] falha transitória ao buscar usuário, repetindo: ${err.message}`);
          await new Promise((r) => setTimeout(r, 300));
        } else {
          logger.error(`[webAuth.resolveUser] ${err.message}`);
        }
      }
    }

    if (!user || user.status !== 'active') {
      req.user = null;
      return next();
    }

    if (
      typeof decoded.sv === 'number' &&
      decoded.sv !== (user.sessionVersion || 0)
    ) {
      req.user = null;
      return next();
    }

    req.user = user;
    res.locals.user = user;
  } catch (err) {
    logger.error(`[webAuth.resolveUser] erro inesperado: ${err.message}`);
    req.user = null;
  }
  return next();
}

async function requireWebAuth(req, res, next) {
  await resolveUser(req, res, () => {});
  if (!req.user) {
    const returnTo = encodeURIComponent(req.originalUrl);
    return res.redirect(`/login?returnTo=${returnTo}`);
  }
  return next();
}

async function redirectIfAuthenticated(req, res, next) {
  await resolveUser(req, res, () => {});
  if (req.user) {
    return res.redirect('/dashboard');
  }
  return next();
}

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
