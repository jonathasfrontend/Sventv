'use strict';

const crypto = require('crypto');
const config = require('../config/app');
const logger = require('../utils/logger');
const metrics = require('../utils/metrics');
const { audit } = require('../services/auditService');
const User = require('../models/User');
const googleAuthService = require('../services/googleAuthService');
const { getGoogleUserInfo, exchangeCodeForToken, GoogleAuthError } = googleAuthService;
const { getClientIp } = require('../utils/ipAddress');

const GOOGLE_OAUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';

const _stateStore = new Map();

const CALLBACK_BASE = () => config.app.baseUrl || 'http://localhost:3000';

// Intenções válidas do fluxo Google: login | register | link.
const VALID_INTENTS = new Set(['login', 'register', 'link']);

function _cleanState(state) {
  return state && typeof state === 'string' ? state.slice(0, 128) : null;
}

function _redactShape(t) {
  if (t === null || t === undefined || typeof t !== 'object') return String(t).slice(0, 120);
  const out = {};
  for (const k of Object.keys(t)) {
    out[k] = ['access_token', 'refresh_token', 'id_token'].includes(k) ? '<present>' : t[k];
  }
  return `${Array.isArray(t) ? 'array' : 'object'} ${JSON.stringify(out).slice(0, 400)}`;
}

function _generateState() {
  return crypto.randomBytes(32).toString('hex');
}

// Consome o state (one-time e com TTL de 5 minutos) e devolve a entrada
// armazenada quando válido — null quando inválido/expirado/reutilizado.
// A entrada carrega `intent` ('login'|'register'|'link') para o callback
// saber EXATAMENTE qual fluxo iniciou o OAuth — separando LOGIN de CADASTRO
// na origem. Fluxo de vínculo também carrega `userId`.
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
  /**
   * GET /api/google/url?intent=login|register
   *
   * Gera a URL de autorização. A intenção (login vs register) é gravada no
   * estado → o Google redireciona de volta e o callback SABE se deve
   * autenticar ou cadastrar. O frontend só envia `intent=register` quando o
   * usuário está na tela de cadastro (e `terms=1` se aceitou os Termos).
   */
  async getGoogleAuthUrl(req, res, next) {
    try {
      const clientId = process.env.GOOGLE_CLIENT_ID;
      if (!clientId) {
        return res.status(503).json({
          success: false,
          message: 'Google OAuth não configurado.',
        });
      }

      const intent = VALID_INTENTS.has(req.query.intent) ? req.query.intent : 'login';
      const terms = intent === 'register' && (req.query.terms === '1' || req.query.terms === 'true');

      const state = _generateState();
      _stateStore.set(state, { createdAt: Date.now(), userId: null, intent, terms });
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
      _stateStore.set(state, { createdAt: Date.now(), userId: req.user._id, intent: 'link' });
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
      const callbackUrl = CALLBACK_BASE();

      const stored = _verifyState(state);
      if (!code || !state || !stored) {
        return res.redirect(`${callbackUrl}/login?error=google&reason=state`);
      }

      const { tokens } = await exchangeCodeForToken(code);
      if (!tokens || !tokens.access_token) {
        const exchangeErr = tokens && tokens.error ? tokens.error + (tokens.error_description ? `: ${tokens.error_description}` : '') : `(sem error/access_token; typeof=${typeof tokens} shape=${_redactShape(tokens)})`;
        logger.warn(`Google token exchange: resposta sem access_token [${exchangeErr}]`);
        metrics.inc('google.failure');
        return res.redirect(`${callbackUrl}/login?error=google&reason=token`);
      }

      const googleInfo = await getGoogleUserInfo(tokens.access_token);
      if (!googleInfo || !googleInfo.email || !googleInfo.verifiedEmail) {
        metrics.inc('google.failure');
        return res.redirect(`${callbackUrl}/login?error=google&reason=unverified`);
      }

      const intent = stored.intent === 'register' ? 'register' : 'login';

      // ── VÍNCULO (perfil logado) ──────────────────────────────
      if (intent === 'link' || stored.userId) {
        const user = await User.findById(stored.userId);
        if (!user || user.status !== 'active') {
          return res.redirect(`${callbackUrl}/login?error=google`);
        }
        try {
          await googleAuthService.linkGoogleAccount(googleInfo, user);
        } catch (err) {
          if (err instanceof GoogleAuthError && err.statusCode === 409) {
            audit({
              action: 'auth.google.link.rejected',
              req, userId: user._id, email: user.email,
              meta: { googleId: googleInfo.googleId, email: googleInfo.email, reason: err.code },
            });
            return res.redirect(`${callbackUrl}/profile?google=conflict&linked=0`);
          }
          throw err;
        }
        audit({
          action: 'auth.google.linked', req, userId: user._id, email: user.email,
          meta: { googleId: googleInfo.googleId, email: googleInfo.email },
        });
        return res.redirect(`${callbackUrl}/profile?linked=1`);
      }

      // ── CADASTRO via Google ──────────────────────────────────
      if (intent === 'register') {
        if (!stored.terms) {
          return res.redirect(`${callbackUrl}/register?error=google&reason=terms`);
        }
        try {
          const { user, created } = await googleAuthService.registerWithGoogle(
            googleInfo,
            { registrationIp: getClientIp(req) }
          );
          setSessionCookie(res, await googleAuthService.generateSessionToken(user));
          audit({
            action: created ? 'auth.google.registration' : 'auth.google.login',
            req, userId: user._id, email: user.email,
            meta: { created, provider: 'google', emailVerified: googleInfo.verifiedEmail },
          });
          return res.redirect(`${callbackUrl}/dashboard`);
        } catch (err) {
          if (err instanceof GoogleAuthError && err.code === 'EMAIL_ALREADY_EXISTS') {
            audit({
              action: 'auth.google.registration.rejected',
              req, email: googleInfo.email,
              meta: { googleId: googleInfo.googleId, reason: err.code },
            });
            return res.redirect(`${callbackUrl}/register?error=google&reason=email_taken`);
          }
          if (err instanceof GoogleAuthError) {
            return res.redirect(`${callbackUrl}/register?error=google&reason=${encodeURIComponent(err.code)}`);
          }
          throw err;
        }
      }

      // ── LOGIN via Google (padrão; inclui estado legado sem intent) ──
      try {
        const { user } = await googleAuthService.loginWithGoogle(googleInfo);
        setSessionCookie(res, await googleAuthService.generateSessionToken(user));
        audit({
          action: 'auth.google.login', req, userId: user._id, email: user.email,
          meta: { provider: 'google', emailVerified: googleInfo.verifiedEmail },
        });
        return res.redirect(`${callbackUrl}/dashboard`);
      } catch (err) {
        if (err instanceof GoogleAuthError) {
          return res.redirect(`${callbackUrl}/login?error=google&reason=account_not_found`);
        }
        throw err;
      }
    } catch (err) {
      logger.error(`[googleAuth.callback] ${err.message}`);
      metrics.inc('google.failure');
      res.redirect(`${CALLBACK_BASE()}/login?error=google`);
    }
  },

  /**
   * POST /api/google/login — LOGIN via Google (NUNCA cria conta).
   * Define o cookie httpOnly de sessão (mesma política do callback).
   */
  async googleLogin(req, res, next) {
    try {
      const { code, state } = req.body;
      if (!code || !state || !_verifyState(state)) {
        return res.status(400).json({ success: false, message: 'Estado inválido ou expirado.' });
      }

      const { tokens } = await exchangeCodeForToken(code);
      if (!tokens || !tokens.access_token) {
        metrics.inc('google.failure');
        return res.status(401).json({ success: false, message: 'Autenticação Google falhou.' });
      }

      const googleInfo = await getGoogleUserInfo(tokens.access_token);
      if (!googleInfo || !googleInfo.email || !googleInfo.verifiedEmail) {
        metrics.inc('google.failure');
        return res.status(401).json({ success: false, message: 'E-mail não verificado.' });
      }

      let user;
      try {
        ({ user } = await googleAuthService.loginWithGoogle(googleInfo));
      } catch (err) {
        if (err instanceof GoogleAuthError) {
          audit({
            action: 'auth.google.login.failed', req, email: googleInfo.email,
            meta: { googleId: googleInfo.googleId, reason: err.code },
          });
          return res.status(err.statusCode).json({ success: false, message: err.message });
        }
        throw err;
      }

      const sessionToken = await googleAuthService.generateSessionToken(user);
      setSessionCookie(res, sessionToken);

      logger.info(`[googleAuth.login] ${user.email}`);
      audit({
        action: 'auth.google.login', req, userId: user._id, email: user.email,
        meta: { provider: 'google' },
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

  /**
   * POST /api/google/register — CADASTRO via Google.
   * Cria conta apenas neste fluxo explícito (exige Termos). Se o googleId
   * já existe, NÃO duplica (login idempotente). Se o e-mail pertence a outra
   * conta, REJEITA (nunca vincula silenciosamente).
   */
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
        metrics.inc('google.failure');
        return res.status(401).json({ success: false, message: 'Autenticação Google falhou.' });
      }

      const googleInfo = await getGoogleUserInfo(tokens.access_token);
      if (!googleInfo || !googleInfo.email || !googleInfo.verifiedEmail) {
        metrics.inc('google.failure');
        return res.status(401).json({ success: false, message: 'E-mail não verificado.' });
      }

      let result;
      try {
        result = await googleAuthService.registerWithGoogle(
          googleInfo,
          { registrationIp: getClientIp(req) }
        );
      } catch (err) {
        if (err instanceof GoogleAuthError) {
          audit({
            action: 'auth.google.registration.rejected', req, email: googleInfo.email,
            meta: { googleId: googleInfo.googleId, reason: err.code },
          });
          return res.status(err.statusCode).json({ success: false, message: err.message });
        }
        throw err;
      }

      const { user, created } = result;
      const sessionToken = await googleAuthService.generateSessionToken(user);
      setSessionCookie(res, sessionToken);

      logger.info(`[googleAuth.register] ${user.email}`);
      audit({
        action: created ? 'auth.google.registration' : 'auth.google.login',
        req, userId: user._id, email: user.email,
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

  /**
   * POST /api/google/link — vínculo explícito (sessão + terms do perfil).
   * Delega a regra de negócio ao service (guards de dono de googleId e email).
   */
  async linkGoogleAccount(req, res, next) {
    try {
      const { code, state } = req.body;
      if (!code || !state || !_verifyState(state)) {
        return res.status(400).json({ success: false, message: 'Estado inválido.' });
      }

      const { tokens } = await exchangeCodeForToken(code);
      if (!tokens?.access_token) {
        metrics.inc('google.failure');
        return res.status(401).json({ success: false, message: 'Autenticação Google falhou.' });
      }

      const googleInfo = await getGoogleUserInfo(tokens.access_token);
      if (!googleInfo?.email) {
        return res.status(401).json({ success: false, message: 'Informações do Google indisponíveis.' });
      }

      try {
        const { user, alreadyLinked } = await googleAuthService.linkGoogleAccount(googleInfo, req.user);
        if (!alreadyLinked) {
          logger.info(`[googleAuth.link] ${user.email} linked Google (${googleInfo.googleId})`);
        }
        audit({
          action: 'auth.google.linked',
          req, userId: user._id, email: user.email,
          meta: { googleId: googleInfo.googleId, email: googleInfo.email, alreadyLinked },
        });
        return res.status(200).json({
          success: true,
          message: alreadyLinked ? 'Sua conta já está vinculada a este Google.' : 'Google vinculado à conta.',
        });
      } catch (err) {
        if (err instanceof GoogleAuthError) {
          audit({
            action: 'auth.google.link.rejected', req, userId: req.user._id, email: req.user.email,
            meta: { googleId: googleInfo.googleId, email: googleInfo.email, reason: err.code },
          });
          return res.status(err.statusCode).json({ success: false, message: err.message });
        }
        throw err;
      }
    } catch (err) {
      logger.error(`[googleAuth.link] ${err.message}`);
      metrics.inc('google.failure');
      next(err);
    }
  },

  /**
   * POST /api/google/unlink — desvínculo com guard: NUNCA deixa a conta sem
   * método de autenticação (conta criada via Google = sem senha utilizável).
   */
  async unlinkGoogleAccount(req, res, next) {
    try {
      try {
        await googleAuthService.unlinkGoogleAccount(req.user._id);
      } catch (err) {
        if (err instanceof GoogleAuthError) {
          return res.status(err.statusCode).json({ success: false, message: err.message });
        }
        throw err;
      }
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