/**
 * SvenTV API - Serviço de Autenticação
 *
 * Camada de negócio pura: sem Express, sem req/res.
 * Toda a lógica de criação de conta, login e gestão de tokens
 * está centralizada aqui, facilitando testes e reutilização.
 */

'use strict';

const User = require('../models/User');
const logger = require('../utils/logger');
const { isDatabaseConnected, createDatabaseUnavailableError } = require('../utils/dbState');

// ─────────────────────────────────────────────────────────────
// Tipos de resposta (JSDoc apenas para DX)
// ─────────────────────────────────────────────────────────────

/**
 * @typedef {Object} RegisterResult
 * @property {Object} user   - Dados públicos do usuário criado
 * @property {string} apiToken - Token de acesso à API
 * @property {string} sessionToken - Token de sessão JWT
 */

/**
 * @typedef {Object} LoginResult
 * @property {Object} user
 * @property {string} sessionToken
 * @property {string} apiToken
 */

// ─────────────────────────────────────────────────────────────
// AuthService
// ─────────────────────────────────────────────────────────────

const authService = {
  /**
   * Registra um novo usuário.
   *
   * @param {{ name: string, email: string, password: string, avatar?: string }} data
   * @returns {Promise<RegisterResult>}
   * @throws {Error} com propriedade `statusCode`
   */
  async register({ name, email, password, avatar }) {
    if (!isDatabaseConnected()) {
      throw createDatabaseUnavailableError(
        'Serviço de autenticação temporariamente indisponível. Tente novamente em instantes.'
      );
    }

    // Verifica duplicidade de e-mail
    const existing = await User.findOne({ email: email.toLowerCase().trim() });

    if (existing) {
      const err = new Error('Este e-mail já está cadastrado.');
      err.statusCode = 409;
      throw err;
    }

    // Cria o usuário com senha hash e token de API inicial
    const user = await User.create({
      name: name.trim(),
      email: email.toLowerCase().trim(),
      password,
      avatar: avatar || '',
    });

    // Busca com apiToken para retorno no registro
    const userWithToken = await User.findByIdWithSensitive(user._id);

    const sessionToken = user.generateSessionToken();
    const apiToken = userWithToken.apiToken;

    logger.info(`✅ Novo usuário registrado: ${user.email}`);

    return {
      user: user.toJSON(),
      sessionToken,
      apiToken,
    };
  },

  /**
   * Autentica um usuário com e-mail e senha.
   *
   * @param {{ email: string, password: string, ip?: string }} data
   * @returns {Promise<LoginResult>}
   * @throws {Error} com propriedade `statusCode`
   */
  async login({ email, password, ip }) {
    if (!isDatabaseConnected()) {
      throw createDatabaseUnavailableError(
        'Serviço de autenticação temporariamente indisponível. Tente novamente em instantes.'
      );
    }

    // Busca usuário com campos protegidos
    const user = await User.findByEmailWithPassword(email);

    if (!user) {
      // Não revela se o e-mail existe ou não
      const err = new Error('Credenciais inválidas.');
      err.statusCode = 401;
      throw err;
    }

    // Verifica bloqueio por tentativas excessivas
    if (user.isLocked) {
      const lockUntilTs = new Date(user.lockUntil).getTime();
      const minutesLeft = Math.max(1, Math.ceil((lockUntilTs - Date.now()) / 60000));
      const err = new Error(
        `Conta temporariamente bloqueada. Tente novamente em ${minutesLeft} minuto(s).`
      );
      err.statusCode = 423;
      throw err;
    }

    // Verifica status da conta
    if (user.status !== 'active') {
      const err = new Error(`Conta ${user.status}. Entre em contato com o suporte.`);
      err.statusCode = 403;
      throw err;
    }

    // Verifica a senha
    const isPasswordValid = await user.comparePassword(password);

    if (!isPasswordValid) {
      // Incrementa tentativas e potencialmente bloqueia
      await user.incLoginAttempts();
      const err = new Error('Credenciais inválidas.');
      err.statusCode = 401;
      throw err;
    }

    // Login bem-sucedido: reseta tentativas e registra IP/timestamp
    await user.resetLoginAttempts();

    if (ip) {
      await User.findByIdAndUpdate(user._id, { lastLoginIp: ip });
    }

    const sessionToken = user.generateSessionToken();
    const userWithApiToken = await User.findByIdWithSensitive(user._id);

    logger.info(`🔑 Login bem-sucedido: ${user.email} | IP=${ip || 'desconhecido'}`);

    return {
      user: user.toJSON(),
      sessionToken,
      apiToken: userWithApiToken.apiToken,
    };
  },

  /**
   * Retorna o perfil público do usuário junto com seu API token.
   *
   * @param {string} userId
   * @returns {Promise<{ user: Object, apiToken: string }>}
   */
  async getProfile(userId) {
    if (!isDatabaseConnected()) {
      throw createDatabaseUnavailableError(
        'Serviço de autenticação temporariamente indisponível. Tente novamente em instantes.'
      );
    }

    const user = await User.findByIdWithSensitive(userId);

    if (!user) {
      const err = new Error('Usuário não encontrado.');
      err.statusCode = 404;
      throw err;
    }

    const apiToken = user.apiToken;
    const publicUser = user.toJSON();

    return { user: publicUser, apiToken };
  },

  /**
   * Atualiza dados do perfil (name, avatar).
   *
   * @param {string} userId
   * @param {{ name?: string, avatar?: string }} data
   * @returns {Promise<Object>} Usuário atualizado
   */
  async updateProfile(userId, data) {
    if (!isDatabaseConnected()) {
      throw createDatabaseUnavailableError(
        'Serviço de autenticação temporariamente indisponível. Tente novamente em instantes.'
      );
    }

    const allowedFields = {};
    if (data.name) allowedFields.name = data.name.trim();
    if (data.avatar !== undefined) allowedFields.avatar = data.avatar;

    const user = await User.findByIdAndUpdate(userId, { $set: allowedFields });

    if (!user) {
      const err = new Error('Usuário não encontrado.');
      err.statusCode = 404;
      throw err;
    }

    logger.info(`✏️  Perfil atualizado: ${user.email}`);
    return user.toJSON();
  },

  /**
   * Altera a senha do usuário.
   *
   * @param {string} userId
   * @param {{ currentPassword: string, newPassword: string }} data
   * @returns {Promise<void>}
   */
  async changePassword(userId, { currentPassword, newPassword }) {
    if (!isDatabaseConnected()) {
      throw createDatabaseUnavailableError(
        'Serviço de autenticação temporariamente indisponível. Tente novamente em instantes.'
      );
    }

    const user = await User.findByIdWithSensitive(userId);

    if (!user) {
      const err = new Error('Usuário não encontrado.');
      err.statusCode = 404;
      throw err;
    }

    const isValid = await user.comparePassword(currentPassword);
    if (!isValid) {
      const err = new Error('Senha atual incorreta.');
      err.statusCode = 401;
      throw err;
    }

    await User.updatePassword(userId, newPassword);

    // Revoga todas as sessões ativas (outras abas/dispositivos caem)
    await User.bumpSessionVersion(userId);

    logger.info(`🔒 Senha alterada: ${user.email}`);

    // Reemite a sessão para o dispositivo que trocou a senha
    const fresh = await User.findById(userId);
    return { sessionToken: fresh ? fresh.generateSessionToken() : null };
  },

  /**
   * Revoga todas as sessões ativas do usuário (logout server-side).
   *
   * @param {string} userId
   * @returns {Promise<void>}
   */
  async logout(userId) {
    if (!isDatabaseConnected()) {
      throw createDatabaseUnavailableError(
        'Serviço de autenticação temporariamente indisponível. Tente novamente em instantes.'
      );
    }

    await User.bumpSessionVersion(userId);
  },

  /**
   * Regenera o API token do usuário, revogando o anterior.
   *
   * @param {string} userId
   * @returns {Promise<string>} Novo API token
   */
  async regenerateApiToken(userId) {
    if (!isDatabaseConnected()) {
      throw createDatabaseUnavailableError(
        'Serviço de autenticação temporariamente indisponível. Tente novamente em instantes.'
      );
    }

    const user = await User.findByIdWithSensitive(userId);

    if (!user) {
      const err = new Error('Usuário não encontrado.');
      err.statusCode = 404;
      throw err;
    }

    const newToken = await user.regenerateApiToken();
    logger.info(`🔄 API token regenerado: ${user.email}`);
    return newToken;
  },
};

module.exports = authService;
