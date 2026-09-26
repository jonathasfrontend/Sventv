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
const { validateAvatarUrl } = require('../services/avatarService');
const { audit } = require('../services/auditService');
const { passwordResetService, PasswordResetError } = require('../services/passwordResetService');
const { getClientIp } = require('../utils/ipAddress');

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
      // IP real coletado no servidor (backend-side, NUNCA aceito do frontend).
      // Guardado em users.registration_ip para auditoria e blocklist WAF.
      const ip = getClientIp(req);

      const result = await authService.register({
        name,
        email,
        password,
        confirmPassword,
        acceptedTerms,
        avatar,
        registrationIp: ip,
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
        message: 'Conta criada com sucesso!',
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
        message: 'Login realizado com sucesso!',
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
   * Atualiza nome e/ou avatar (URL externa HTTPS) do usuário autenticado.
   * `avatar: ''` limpa o avatar personalizado (volta ao Google, se houver).
   * Requer: requireSessionAuth
   */
  async updateProfile(req, res, next) {
    try {
      const data = { ...req.body };

      // Avatar é URL externa validada (migração v2.0.1 — não há mais upload).
      // Vazio = limpar avatar personalizado (avatarSource volta a 'google'
      // quando o usuário tem Google vinculado).
      if (data.avatar !== undefined) {
        if (String(data.avatar).trim() === '') {
          data.avatar = '';
        } else {
          data.avatar = await validateAvatarUrl(data.avatar);
        }
      }

      const updatedUser = await authService.updateProfile(req.user._id, data);

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
        message: 'Senha alterada com sucesso.',
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

      logger.info(`Novo token gerado para o usuário: ${req.user.email}`);

      audit({
        action: 'auth.regenerate_api_token',
        req,
        userId: req.user._id,
        email: req.user.email,
      });

      return res.status(200).json({
        success: true,
        message: 'API token regenerado com sucesso.',
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
      logger.warn(`Falha inesperada na redefinição de senha: ${err && err.message}`);
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
