/**
 * SvenTV API - Controller de Autenticação
 *
 * Camada HTTP: lida apenas com req/res, delega toda lógica
 * de negócio ao authService. Respostas padronizadas.
 */

'use strict';

const authService = require('../services/authService');
const googleAuthService = require('../services/googleAuthService');
const captchaService = require('../services/captchaService');
const logger = require('../utils/logger');
const config = require('../config/app');
const metrics = require('../utils/metrics');
const { uploadAvatar } = require('../services/avatarService');
const { audit } = require('../services/auditService');
const { passwordResetService, PasswordResetError } = require('../services/passwordResetService');

const _googleStateStore = new Map();

function generateGoogleState() {
  const crypto = require('crypto');
  const state = crypto.randomBytes(32).toString('hex');
  _googleStateStore.set(state, { createdAt: Date.now() });
  setTimeout(() => _googleStateStore.delete(state), 300_000);
  return state;
}

function verifyGoogleState(state) {
  if (!state || typeof state !== 'string') return false;
  const entry = _googleStateStore.get(state);
  if (!entry) return false;
  _googleStateStore.delete(state);
  return Date.now() - entry.createdAt < 300_000;
}

// ─────────────────────────────────────────────────────────────
// Helper: extrai o IP real considerando proxies
// ─────────────────────────────────────────────────────────────

const getClientIp = (req) =>
  req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || req.ip;

// ─────────────────────────────────────────────────────────────
// Helper: define o cookie de sessão na resposta
// ─────────────────────────────────────────────────────────────

const setSessionCookie = (res, token) => {
  res.cookie('sessionToken', token, {
    httpOnly: true,
    secure: config.env === 'production',
    sameSite: 'Lax',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 dias
    path: '/',
  });
};

// ─────────────────────────────────────────────────────────────
// Controller
// ─────────────────────────────────────────────────────────────

const authController = {
  /**
   * POST /auth/register
   * Cria uma nova conta de usuário.
   */
  async register(req, res, next) {
    try {
      const { name, email, password, confirmPassword, acceptedTerms, avatar } = req.body;

      const result = await authService.register({
        name,
        email,
        password,
        confirmPassword,
        acceptedTerms,
        avatar,
      });

      setSessionCookie(res, result.sessionToken);

      audit({
        action: 'auth.register',
        req,
        userId: result.user?.id,
        email: result.user?.email,
      });

      audit({
        action: 'TERMS_ACCEPTED',
        req,
        userId: result.user?.id,
        email: result.user?.email,
        meta: { version: config.terms.version },
      });

      return res.status(201).json({
        success: true,
        message: 'Conta criada com sucesso! Guarde seu token de API em local seguro.',
        data: {
          user: result.user,
          sessionToken: result.sessionToken,
          apiToken: result.apiToken,
        },
      });
    } catch (err) {
      if (err.statusCode) {
        return res.status(err.statusCode).json({ success: false, message: err.message });
      }
      next(err);
    }
  },

  /**
   * POST /auth/login
   * Autentica o usuário e retorna tokens de sessão e API.
   */
  async login(req, res, next) {
    try {
      const { email, password } = req.body;
      const ip = getClientIp(req);

      const result = await authService.login({ email, password, ip });

      setSessionCookie(res, result.sessionToken);

      audit({
        action: 'auth.login',
        req,
        userId: result.user?.id,
        email: result.user?.email,
      });

      return res.status(200).json({
        success: true,
        message: 'Login realizado com sucesso.',
        data: {
          user: result.user,
          sessionToken: result.sessionToken,
          apiToken: result.apiToken,
        },
      });
    } catch (err) {
      if (err.statusCode) {
        return res.status(err.statusCode).json({ success: false, message: err.message });
      }
      next(err);
    }
  },

  /**
   * GET /auth/profile
   * Retorna os dados do usuário autenticado com o API token.
   * Requer: requireSessionAuth
   */
  async getProfile(req, res, next) {
    try {
      const result = await authService.getProfile(req.user._id);

      return res.status(200).json({
        success: true,
        message: 'Perfil carregado com sucesso.',
        data: {
          user: result.user,
          apiToken: result.apiToken,
        },
      });
    } catch (err) {
      if (err.statusCode) {
        return res.status(err.statusCode).json({ success: false, message: err.message });
      }
      next(err);
    }
  },

  /**
   * GET /auth/api-token
   * Retorna APENAS o API token do usuário autenticado.
   * Endpoint dedicado para a página de perfil buscar o token sob demanda
   * (clique em "Mostrar"), sem precisar injetá-lo no HTML renderizado.
   * Requer: requireSessionAuth
   */
  async revealApiToken(req, res, next) {
    try {
      const result = await authService.getProfile(req.user._id);

      // NUNCA cachear: um token antigo servido de cache do navegador (304)
      // faz as chamadas seguintes falharem com 401 e entram em loop de login.
      res.setHeader('Cache-Control', 'no-store');

      return res.status(200).json({
        success: true,
        message: 'API token recuperado com sucesso.',
        data: { apiToken: result.apiToken },
      });
    } catch (err) {
      if (err.statusCode) {
        return res.status(err.statusCode).json({ success: false, message: err.message });
      }
      next(err);
    }
  },

  /**
   * PUT /auth/profile
   * Atualiza nome e/ou avatar do usuário autenticado.
   * Requer: requireSessionAuth
   */
  async updateProfile(req, res, next) {
    try {
      const updatedUser = await authService.updateProfile(req.user._id, req.body);

      return res.status(200).json({
        success: true,
        message: 'Perfil atualizado com sucesso.',
        data: { user: updatedUser },
      });
    } catch (err) {
      if (err.statusCode) {
        return res.status(err.statusCode).json({ success: false, message: err.message });
      }
      next(err);
    }
  },

  /**
   * POST /auth/avatar
   * Envia avatar para o Supabase Storage e atualiza o perfil do usuário.
   * Requer: requireSessionAuth
   */
  async uploadAvatar(req, res, next) {
    try {
      const avatarUrl = await uploadAvatar({
        file: req.file,
        imageUrl: req.body?.imageUrl,
        userId: req.user._id,
      });

      const updatedUser = await authService.updateProfile(req.user._id, { avatar: avatarUrl });

      return res.status(200).json({
        success: true,
        message: 'Avatar atualizado com sucesso.',
        data: { avatar: avatarUrl, user: updatedUser },
      });
    } catch (err) {
      if (err.statusCode) {
        return res.status(err.statusCode).json({ success: false, message: err.message });
      }
      next(err);
    }
  },

  /**
   * POST /auth/change-password
   * Altera a senha do usuário autenticado.
   * Requer: requireSessionAuth
   */
  async changePassword(req, res, next) {
    try {
      const result = await authService.changePassword(req.user._id, req.body);

      // Reemite o cookie com a nova sessão (as antigas foram revogadas)
      if (result?.sessionToken) {
        setSessionCookie(res, result.sessionToken);
      }

      audit({
        action: 'auth.change_password',
        req,
        userId: req.user._id,
        email: req.user.email,
      });

      return res.status(200).json({
        success: true,
        message: 'Senha alterada com sucesso. As demais sessões ativas foram encerradas.',
      });
    } catch (err) {
      if (err.statusCode) {
        return res.status(err.statusCode).json({ success: false, message: err.message });
      }
      next(err);
    }
  },

  /**
   * POST /auth/regenerate-token
   * Revoga o API token atual e gera um novo.
   * Requer: requireSessionAuth
   */
  async regenerateApiToken(req, res, next) {
    try {
      const newToken = await authService.regenerateApiToken(req.user._id);

      logger.info(`🔄 Token regenerado para o usuário: ${req.user.email}`);

      audit({
        action: 'auth.regenerate_api_token',
        req,
        userId: req.user._id,
        email: req.user.email,
      });

      return res.status(200).json({
        success: true,
        message: 'API token regenerado com sucesso. O token anterior foi revogado.',
        data: { apiToken: newToken },
      });
    } catch (err) {
      if (err.statusCode) {
        return res.status(err.statusCode).json({ success: false, message: err.message });
      }
      next(err);
    }
  },

  /**
   * POST /auth/forgot-password
   * Solicita um código de recuperação por e-mail.
   * Resposta GENÉRICA idêntica para e-mail existente/inexistente
   * (anti-enumeração) e ainda que o envio SMTP falhe.
   */
  async forgotPassword(req, res, next) {
    try {
      const { email } = req.body;
      await passwordResetService.requestPasswordReset({ email, req });

      return res.status(200).json({
        success: true,
        message:
          'Se o e-mail estiver cadastrado, você receberá um código de recuperação em instantes.',
      });
    } catch (err) {
      next(err);
    }
  },

  /**
   * POST /auth/reset-password
   * Redefine a senha com e-mail + código de 6 dígitos.
   * Em sucesso, TODAS as sessões do usuário são revogadas.
   */
  async resetPassword(req, res, next) {
    try {
      const { email, code, newPassword } = req.body;
      await passwordResetService.resetPassword({ email, code, newPassword, req });

      return res.status(200).json({
        success: true,
        message: 'Senha redefinida com sucesso. Faça login novamente.',
      });
    } catch (err) {
      if (err instanceof PasswordResetError) {
        // Mensagem já genérica no serviço — NUNCA diferencia motivo.
        return res.status(400).json({ success: false, message: err.message });
      }
      logger.warn(`🔒 Falha inesperada na redefinição de senha: ${err && err.message}`);
      return res.status(500).json({
        success: false,
        message: 'Não foi possível concluir a operação. Tente novamente em instantes.',
      });
    }
  },

  /**
   * POST /auth/logout
   * Revoga TODAS as sessões do usuário (bump de sessionVersion) e limpa o
   * cookie. Tokens de sessão emitidos antes deixam de ser aceitos.
   */
  async generateGoogleState(req, res, next) {
    try {
      if (!process.env.GOOGLE_CLIENT_ID) {
        return res.status(503).json({ success: false, message: 'Google OAuth não configurado.' });
      }
      const state = generateGoogleState();
      res.status(200).json({ success: true, data: { state } });
    } catch (err) { next(err); }
  },

  async googleCallback(req, res, next) {
    try {
      const { code, state } = req.query;
      const callbackUrl = config.app.baseUrl || 'http://localhost:3000';
      if (!code || !state || !verifyGoogleState(state)) {
        return res.status(400).json({ success: false, message: 'Estado inválido ou expirado.' });
      }
      return res.redirect(`${callbackUrl}/login?google=1&state=${state}`);
    } catch (err) { logger.error(`[googleCallback] ${err.message}`); next(err); }
  },

  async googleLogin(req, res, next) {
    try {
      const { code, state } = req.body;
      if (!code || !state || !verifyGoogleState(state)) {
        return res.status(400).json({ success: false, message: 'Estado inválido ou expirado.' });
      }
      const { tokens } = await googleAuthService.exchangeCodeForToken(code);
      if (!tokens?.access_token) {
        return res.status(401).json({ success: false, message: 'Autenticação Google falhou.' });
      }
      const googleInfo = await googleAuthService.getGoogleUserInfo(tokens.access_token);
      if (!googleInfo?.email) {
        return res.status(401).json({ success: false, message: 'Informações do Google indisponíveis.' });
      }
      googleInfo.verifiedEmail = googleInfo.verifiedEmail || false;
      const { user, created } = await googleAuthService.findOrCreateUser(googleInfo);
      const sessionToken = googleAuthService.generateSessionToken(user);
      logger.info(`[googleLogin] ${user.email}`);
      metrics.inc('google.login');
      audit({ action: 'auth.google.login', req, userId: user._id, email: user.email, meta: { created } });
      setSessionCookie(res, sessionToken);
      return res.status(200).json({ success: true, message: 'Login via Google realizado.', data: { user: user.toJSON(), sessionToken } });
    } catch (err) { logger.error(`[googleLogin] ${err.message}`); next(err); }
  },

  async googleRegister(req, res, next) {
    try {
      const { code, state, acceptedTerms } = req.body;
      if (!code || !state || !verifyGoogleState(state)) {
        return res.status(400).json({ success: false, message: 'Estado inválido ou expirado.' });
      }
      if (acceptedTerms !== true) { return res.status(422).json({ success: false, message: 'Aceite os Termos de Uso.' }); }
      const { tokens } = await googleAuthService.exchangeCodeForToken(code);
      if (!tokens?.access_token) {
        return res.status(401).json({ success: false, message: 'Autenticação Google falhou.' });
      }
      const googleInfo = await googleAuthService.getGoogleUserInfo(tokens.access_token);
      if (!googleInfo?.email) {
        return res.status(401).json({ success: false, message: 'Informações do Google indisponíveis.' });
      }
      googleInfo.verifiedEmail = googleInfo.verifiedEmail || false;
      const { user, created } = await googleAuthService.findOrCreateUser(googleInfo);
      const sessionToken = googleAuthService.generateSessionToken(user);
      logger.info(`[googleRegister] ${user.email}`);
      metrics.inc('google.register');
      audit({ action: 'auth.google.register', req, userId: user._id, email: user.email, meta: { created } });
      setSessionCookie(res, sessionToken);
      return res.status(created ? 201 : 200).json({ success: true, message: created ? 'Conta criada via Google.' : 'Login via Google realizado.', data: { user: user.toJSON(), sessionToken } });
    } catch (err) { logger.error(`[googleRegister] ${err.message}`); next(err); }
  },

  async getGoogleAuthUrl(req, res, next) {
    try {
      const clientId = process.env.GOOGLE_CLIENT_ID;
      if (!clientId) { return res.status(503).json({ success: false, message: 'Google OAuth não configurado.' }); }
      const state = generateGoogleState();
      const params = new URLSearchParams({ client_id: clientId, redirect_uri: process.env.GOOGLE_REDIRECT_URI || '', response_type: 'code', scope: 'openid email profile', state, access_type: 'offline', prompt: 'consent' });
      res.status(200).json({ success: true, data: { authUrl: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`, state } });
    } catch (err) { next(err); }
  },

  async logout(req, res, next) {
    try {
      if (req.user?._id) {
        await authService.logout(req.user._id);
      }

      logger.info(`👋 Logout: ${req.user?.email || 'desconhecido'}`);

      audit({
        action: 'auth.logout',
        req,
        userId: req.user?._id,
        email: req.user?.email,
      });

      res.clearCookie('sessionToken', { path: '/' });
      return res.status(200).json({
        success: true,
        message: 'Logout realizado com sucesso.',
      });
    } catch (err) {
      if (err.statusCode) {
        return res.status(err.statusCode).json({ success: false, message: err.message });
      }
      next(err);
    }
  },
};

module.exports = authController;
