/**
 * SvenTV API - Controller de Autenticação
 *
 * Camada HTTP: lida apenas com req/res, delega toda lógica
 * de negócio ao authService. Respostas padronizadas.
 */

'use strict';

const authService = require('../services/authService');
const logger = require('../utils/logger');
const config = require('../config/app');
const { uploadAvatar } = require('../services/avatarService');
const { audit } = require('../services/auditService');

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
      const { name, email, password, avatar } = req.body;

      const result = await authService.register({ name, email, password, avatar });

      setSessionCookie(res, result.sessionToken);

      audit({
        action: 'auth.register',
        req,
        userId: result.user?.id,
        email: result.user?.email,
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
   * POST /auth/logout
   * Revoga TODAS as sessões do usuário (bump de sessionVersion) e limpa o
   * cookie. Tokens de sessão emitidos antes deixam de ser aceitos.
   */
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
