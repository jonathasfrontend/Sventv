'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const User = require('../models/User');
const config = require('../config/app');
const logger = require('../utils/logger');
const metrics = require('../utils/metrics');
const { audit } = require('../services/auditService');
const { requireStreamAccess } = require('../middlewares/auth');
const { getGoogleUserInfo, exchangeCodeForToken, findOrCreateUser, generateSessionToken } = require('../services/googleAuthService');

const GOOGLE_OAUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';

const _stateStore = new Map();

function _cleanState(state) {
  return state && typeof state === 'string' ? state.slice(0, 128) : null;
}

function _generateState() {
  return crypto.randomBytes(32).toString('hex');
}

// Consome o state (one-time e com TTL de 5 minutos) e devolve a entrada
// armazenada quando válido — null quando inválido/expirado/reutilizado.
// A entrada carrega `userId` para diferenciar o fluxo de VINCULAÇÃO
// (perfil logado) do fluxo de LOGIN/REGISTRO (página pública).
function _verifyState(state) {
  const stored = _stateStore.get(state);
  if (!stored) return null;
  _stateStore.delete(state);
  const age = Date.now() - stored.createdAt;
  return age < 300_000 ? stored : null;
}

// Define o cookie httpOnly de sessão (mesmo shape do authController).
const setSessionCookie = (res, token) => {
  res.cookie('sessionToken', token, {
    httpOnly: true,
    secure: config.env === 'production',
    sameSite: 'Lax',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 dias
    path: '/',
  });
};

const googleAuthController = {
  async getGoogleAuthUrl(req, res, next) {
    try {
      const clientId = process.env.GOOGLE_CLIENT_ID;
      if (!clientId) {
        return res.status(503).json({
          success: false,
          message: 'Google OAuth não configurado.',
        });
      }
      const state = _generateState();
      _stateStore.set(state, { createdAt: Date.now(), userId: req.user?._id || null });
      setTimeout(() => _stateStore.delete(state), 300_000);

      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: process.env.GOOGLE_REDIRECT_URI || '',
        response_type: 'code',
        scope: 'openid email profile',
        state,
        access_type: 'offline',
        prompt: 'consent',
      });

      res.status(200).json({
        success: true,
        data: {
          authUrl: `${GOOGLE_OAUTH_URL}?${params.toString()}`,
          state,
        },
      });
    } catch (err) {
      logger.error(`[googleAuth.getGoogleAuthUrl] ${err.message}`);
      next(err);
    }
  },

  // URL de autorização para VINCULAR uma conta Google ao usuário logado.
  // Requer sessão (requireSessionAuth); o estado carrega o userId para o
  // callback distinguir vínculo de login.
  async getGoogleLinkUrl(req, res, next) {
    try {
      const clientId = process.env.GOOGLE_CLIENT_ID;
      if (!clientId) {
        return res.status(503).json({ success: false, message: 'Google OAuth não configurado.' });
      }
      if (!req.user) {
        return res.status(401).json({ success: false, message: 'Faça login para vincular sua conta Google.' });
      }

      const state = _generateState();
      _stateStore.set(state, { createdAt: Date.now(), userId: req.user._id });
      setTimeout(() => _stateStore.delete(state), 300_000);

      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: process.env.GOOGLE_REDIRECT_URI || '',
        response_type: 'code',
        scope: 'openid email profile',
        state,
        access_type: 'offline',
        prompt: 'consent',
      });

      res.status(200).json({
        success: true,
        data: {
          authUrl: `${GOOGLE_OAUTH_URL}?${params.toString()}`,
          state,
        },
      });
    } catch (err) {
      logger.error(`[googleAuth.getGoogleLinkUrl] ${err.message}`);
      next(err);
    }
  },

  async googleCallback(req, res, next) {
    try {
      const { code, state } = req.query;
      const callbackUrl = config.app.baseUrl || 'http://localhost:3000';

      const stored = _verifyState(state);
      if (!code || !state || !stored) {
        return res.redirect(`${callbackUrl}/login?error=google&reason=state`);
      }

      const { tokens } = await exchangeCodeForToken(code);
      if (!tokens || !tokens.access_token) {
        const exchangeErr = tokens && tokens.error ? tokens.error + (tokens.error_description ? `: ${tokens.error_description}` : '') : '(sem error/access_token)';
        logger.warn(`Google token exchange: resposta sem access_token [${exchangeErr}]`);
        metrics.inc('google.failure');
        return res.redirect(`${callbackUrl}/login?error=google&reason=token`);
      }

      const googleInfo = await getGoogleUserInfo(tokens.access_token);
      if (!googleInfo || !googleInfo.email || !googleInfo.verifiedEmail) {
        metrics.inc('google.failure');
        return res.redirect(`${callbackUrl}/login?error=google&reason=unverified`);
      }

      // Fluxo de VINCULAÇÃO: estado gerado por /api/google/link-url carrega userId.
      if (stored.userId) {
        const user = await User.findById(stored.userId);
        if (!user || user.status !== 'active') {
          return res.redirect(`${callbackUrl}/login?error=google`);
        }
        const existingByEmail = await User.findByEmail(googleInfo.email);
        if (existingByEmail && existingByEmail._id !== user._id) {
          return res.redirect(`${callbackUrl}/profile?google=conflict&linked=0`);
        }
        await User.findByIdAndUpdate(user._id, {
          googleId: googleInfo.googleId,
          avatar: googleInfo.picture || user.avatar,
        });
        logger.info(`[googleAuth.callback.link] ${user.email} vinculou Google`);
        audit({
          action: 'auth.google.linked', req, userId: user._id, email: user.email,
          meta: { googleId: googleInfo.googleId, email: googleInfo.email },
        });
        return res.redirect(`${callbackUrl}/profile?linked=1`);
      }

      // Fluxo de LOGIN/REGISTRO: define o cookie httpOnly e vai para o dashboard.
      const { user, created } = await findOrCreateUser(googleInfo);
      const sessionToken = await generateSessionToken(user);
      setSessionCookie(res, sessionToken);

      logger.info(`[googleAuth] ${created ? 'Novo' : 'Usuário existente'} via Google: ${user.email}`);
      metrics.inc('google.login');
      if (created) metrics.inc('google.register');

      audit({
        action: created ? 'auth.google.register' : 'auth.google.login',
        req,
        userId: user._id,
        email: user.email,
        meta: { created, provider: 'google', emailVerified: googleInfo.verifiedEmail },
      });

      return res.redirect(`${callbackUrl}/dashboard`);
    } catch (err) {
      logger.error(`[googleAuth.callback] ${err.message}`);
      metrics.inc('google.failure');
      res.redirect(`${config.app.baseUrl || 'http://localhost:3000'}/login?error=google`);
    }
  },

  async googleLogin(req, res, next) {
    try {
      const { code, state } = req.body;
      if (!code || !state || !_verifyState(state)) {
        return res.status(400).json({ success: false, message: 'Estado inválido ou expirado.' });
      }

      const { tokens } = await exchangeCodeForToken(code);
      if (!tokens || !tokens.access_token) {
        return res.status(401).json({ success: false, message: 'Autenticação Google falhou.' });
      }

      const googleInfo = await getGoogleUserInfo(tokens.access_token);
      if (!googleInfo || !googleInfo.email || !googleInfo.verifiedEmail) {
        return res.status(401).json({ success: false, message: 'Email não verificado.' });
      }

      const { user, created } = await findOrCreateUser(googleInfo);
      const sessionToken = await generateSessionToken(user);

      logger.info(`[googleAuth.login] ${user.email}`);
      metrics.inc('google.login');

      audit({
        action: 'auth.google.login', req, userId: user._id, email: user.email,
        meta: { created, provider: 'google' },
      });

      res.status(200).json({
        success: true,
        message: 'Login via Google realizado.',
        data: { user: user.toJSON(), sessionToken },
      });
    } catch (err) {
      logger.error(`[googleAuth.login] ${err.message}`);
      metrics.inc('google.failure');
      next(err);
    }
  },

  async googleRegister(req, res, next) {
    try {
      const { code, state, acceptedTerms } = req.body;
      if (!code || !state || !_verifyState(state)) {
        return res.status(400).json({ success: false, message: 'Estado inválido ou expirado.' });
      }
      if (acceptedTerms !== true) {
        return res.status(422).json({ success: false, message: 'Aceite os Termos de Uso.' });
      }

      const { tokens } = await exchangeCodeForToken(code);
      if (!tokens || !tokens.access_token) {
        return res.status(401).json({ success: false, message: 'Autenticação Google falhou.' });
      }

      const googleInfo = await getGoogleUserInfo(tokens.access_token);
      if (!googleInfo || !googleInfo.email || !googleInfo.verifiedEmail) {
        return res.status(401).json({ success: false, message: 'Email não verificado.' });
      }

      const { user, created } = await findOrCreateUser(googleInfo);
      const sessionToken = await generateSessionToken(user);

      logger.info(`[googleAuth.register] ${user.email}`);
      metrics.inc('google.register');

      audit({
        action: 'auth.google.register', req, userId: user._id, email: user.email,
        meta: { created, provider: 'google' },
      });

      res.status(created ? 201 : 200).json({
        success: true,
        message: created ? 'Conta criada via Google.' : 'Login via Google realizado.',
        data: { user: user.toJSON(), sessionToken },
      });
    } catch (err) {
      logger.error(`[googleAuth.register] ${err.message}`);
      metrics.inc('google.failure');
      next(err);
    }
  },

  async getGoogleUserInfo(req, res, next) {
    try {
      const token = req.headers.authorization?.slice(7);
      if (!token) {
        return res.status(401).json({ success: false, message: 'Token necessário.' });
      }
      const { tokens } = await exchangeCodeForToken(token);
      if (!tokens?.access_token) {
        return res.status(401).json({ success: false, message: 'Token inválido.' });
      }
      const info = await getGoogleUserInfo(tokens.access_token);
      res.status(200).json({ success: true, data: info });
    } catch (err) {
      next(err);
    }
  },

  async linkGoogleAccount(req, res, next) {
    try {
      const { code, state } = req.body;
      if (!code || !state || !_verifyState(state)) {
        return res.status(400).json({ success: false, message: 'Estado inválido.' });
      }

      const { tokens } = await exchangeCodeForToken(code);
      if (!tokens?.access_token) {
        return res.status(401).json({ success: false, message: 'Autenticação Google falhou.' });
      }

      const googleInfo = await getGoogleUserInfo(tokens.access_token);
      if (!googleInfo?.email) {
        return res.status(401).json({ success: false, message: 'Informações do Google indisponíveis.' });
      }

      const existingByEmail = await User.findByEmail(googleInfo.email);
      if (existingByEmail && existingByEmail._id !== req.user._id) {
        return res.status(409).json({ success: false, message: 'Este email já está vinculado a outra conta.' });
      }

      await User.findByIdAndUpdate(req.user._id, {
        googleId: googleInfo.googleId,
        avatar: googleInfo.picture || req.user.avatar,
      });

      logger.info(`[googleAuth.link] ${req.user.email} linked Google (${googleInfo.googleId})`);
      audit({
        action: 'auth.google.linked', req, userId: req.user._id, email: req.user.email,
        meta: { googleId: googleInfo.googleId, email: googleInfo.email },
      });

      res.status(200).json({ success: true, message: 'Google vinculado à conta.' });
    } catch (err) {
      logger.error(`[googleAuth.link] ${err.message}`);
      next(err);
    }
  },

  async unlinkGoogleAccount(req, res, next) {
    try {
      await User.findByIdAndUpdate(req.user._id, { googleId: null });
      logger.info(`[googleAuth.unlink] ${req.user.email} unlinked Google`);
      audit({
        action: 'auth.google.unlinked', req, userId: req.user._id, email: req.user.email,
      });
      res.status(200).json({ success: true, message: 'Google desvinculado.' });
    } catch (err) {
      logger.error(`[googleAuth.unlink] ${err.message}`);
      next(err);
    }
  },
};

module.exports = googleAuthController;
