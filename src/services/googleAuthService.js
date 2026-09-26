'use strict';

const jwt = require('jsonwebtoken');
const axios = require('axios');
const crypto = require('crypto');
const config = require('../config/app');
const User = require('../models/User');
const logger = require('../utils/logger');
const metrics = require('../utils/metrics');
const alertService = require('../services/alertService');

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';

/**
 * Erro de negócio da autenticação Google. Carrega `statusCode` (HTTP) e
 * `code` (identificador estável p/ audit/UI). NUNCA expõe tokens/senhas.
 */
class GoogleAuthError extends Error {
  constructor(message, statusCode = 401, code = 'GOOGLE_AUTH_FAILED') {
    super(message);
    this.name = 'GoogleAuthError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

async function getGoogleUserInfo(accessToken) {
  try {
    const resp = await axios.get(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: 10_000,
    });
    const data = resp.data;
    return {
      googleId: data.sub,
      email: data.email || null,
      name: data.name || null,
      givenName: data.given_name || null,
      familyName: data.family_name || null,
      picture: data.picture || null,
      verifiedEmail: data.verified_email === true || data.email_verified === true,
    };
  } catch (err) {
    logger.warn(`Google userinfo fetch failed: ${err && err.message}`);
    throw new Error('Falha ao obter informações do Google.');
  }
}

async function exchangeCodeForToken(code) {
  try {
    const resp = await axios.post(GOOGLE_TOKEN_URL, new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID || '',
      client_secret: process.env.GOOGLE_CLIENT_SECRET || '',
      redirect_uri: process.env.GOOGLE_REDIRECT_URI || '',
      grant_type: 'authorization_code',
    }).toString(), {
      timeout: 10_000,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    return { tokens: resp.data };
  } catch (err) {
    const details = err && err.response && err.response.data;
    const googleErr = details && details.error ? `${details.error}${details.error_description ? `: ${details.error_description}` : ''}` : '';
    logger.warn(`Google token exchange failed: ${err && err.message}${googleErr ? ` [${googleErr}]` : ''} client=${process.env.GOOGLE_CLIENT_ID} redirect=${process.env.GOOGLE_REDIRECT_URI}`);
    throw new Error('Falha na autenticação com o Google.');
  }
}

/**
 * LOGIN via Google — autentica APENAS contas já cadastradas.
 *
 * REGRA FUNDAMENTAL: LOGIN != CADASTRO. Este fluxo NUNCA cria usuário e
 * NUNCA vincula contas silenciosamente (anti account-takeover).
 *
 * 1) Busca pela identidade Google persistente (googleId = fonte de verdade
 *    do vínculo).
 * 2) Sem match → NEGA o login. NÃO cai no e-mail para vincular/criar.
 *
 * @param {object} googleInfo {googleId, email, verifiedEmail, ...}
 * @returns {Promise<{user, created:false}>}
 * @throws {GoogleAuthError} ACCOUNT_NOT_FOUND / INVALID_IDENTITY / EMAIL_UNVERIFIED
 */
async function loginWithGoogle(googleInfo) {
  if (!googleInfo || !googleInfo.googleId || !googleInfo.email) {
    throw new GoogleAuthError('Autenticação Google inválida.', 401, 'INVALID_IDENTITY');
  }
  if (!googleInfo.verifiedEmail) {
    metrics.inc('google.loginDenied');
    throw new GoogleAuthError('E-mail não verificado.', 401, 'EMAIL_UNVERIFIED');
  }

  const user = await User.findByGoogleId(googleInfo.googleId);
  if (!user || user.status !== 'active') {
    metrics.inc('google.loginDenied');
    throw new GoogleAuthError(
      'Conta não cadastrada. Cadastre-se primeiro para utilizar o login com Google.',
      401,
      'ACCOUNT_NOT_FOUND'
    );
  }

  metrics.inc('google.login');
  return { user, created: false };
}

/**
 * CADASTRO via Google — cria conta SOMENTE no fluxo explícito de cadastro.
 *
 * 1) googleId já cadastrado → NÃO duplica: devolve o usuário (login
 *    idempotente p/ quem já se registrou com este Google).
 * 2) E-mail já pertence a outra conta → REJEITA (409). Nunca faz vínculo
 *    automático: quem já tem conta segue pelo fluxo de vínculo no perfil.
 * 3) Nada existe → cria conta com googleId (authProvider='google', senha
 *    aleatória que NÃO serve para login local — o método é o próprio Google).
 *
 * @param {object} googleInfo {googleId, email, verifiedEmail, name, picture}
 * @param {{ registrationIp?: string|null }} [options] metadados de origem do
 *   cadastro (IP real coletado pelo servidor — nunca vindo do frontend).
 * @returns {Promise<{user, created:boolean}>}
 * @throws {GoogleAuthError} INVALID_IDENTITY / EMAIL_UNVERIFIED / ACCOUNT_UNAVAILABLE / EMAIL_ALREADY_EXISTS
 */
async function registerWithGoogle(googleInfo, options = {}) {
  if (!googleInfo || !googleInfo.googleId || !googleInfo.email) {
    throw new GoogleAuthError('Autenticação Google inválida.', 401, 'INVALID_IDENTITY');
  }
  if (!googleInfo.verifiedEmail) {
    metrics.inc('google.registrationRejected');
    throw new GoogleAuthError('E-mail não verificado.', 401, 'EMAIL_UNVERIFIED');
  }

  const byGoogleId = await User.findByGoogleId(googleInfo.googleId);
  if (byGoogleId) {
    if (byGoogleId.status !== 'active') {
      metrics.inc('google.registrationRejected');
      throw new GoogleAuthError('Conta indisponível.', 403, 'ACCOUNT_UNAVAILABLE');
    }
    metrics.inc('google.login');
    return { user: byGoogleId, created: false };
  }

  const byEmail = await User.findByEmail(googleInfo.email);
  if (byEmail) {
    metrics.inc('google.registrationRejected');
    if (byEmail.googleId && byEmail.googleId !== googleInfo.googleId) {
      metrics.inc('googleIdMismatch');
      logger.warn(`Google ID mismatch for email ${googleInfo.email}`);
    }
    throw new GoogleAuthError(
      'Já existe uma conta com este e-mail. Faça login e vincule sua conta Google no perfil.',
      409,
      'EMAIL_ALREADY_EXISTS'
    );
  }

  const newUser = await User.create({
    name: googleInfo.name || googleInfo.email || 'Usuário Google',
    email: googleInfo.email,
    password: crypto.randomBytes(32).toString('hex'),
    // avatar personalizado começa VAZIO; o picture do Google vai para
    // googleAvatarUrl. O avatar efetivo exibido = avatar || googleAvatarUrl,
    // então no cadastro o usuário já vê a foto do Google — mas se depois ele
    // definir um avatar externo, o picture continua lá para o fallback.
    avatar: '',
    googleAvatarUrl: googleInfo.picture || null,
    googleId: googleInfo.googleId,
    authProvider: 'google',
    termsAcceptedAt: new Date(),
    termsVersion: config.terms.version,
    registrationIp: options.registrationIp || null,
  });

  metrics.inc('google.register');
  metrics.inc('google.userCreated');
  metrics.inc('termsAccepted');
  alertService.notify('auth.user_registered:' + newUser._id, {
    event: 'auth.user_registered',
    userId: newUser._id,
    name: newUser.name,
    email: newUser.email,
    authProvider: 'google',
    createdAt: newUser.createdAt ? newUser.createdAt.toISOString() : new Date().toISOString(),
  });

  return { user: newUser, created: true };
}

/**
 * VÍNCULO do googleId a uma conta já autenticada (fluxo explícito do perfil).
 *
 * Guards anti duplicidade/takeover:
 * - googleId já pertence a OUTRO usuário → 409 (não move, não sobrescreve).
 * - e-mail do Google já pertence a OUTRO usuário → 409.
 * - já vinculado a ESTA conta → idempotente (success).
 *
 * @param {object} googleInfo {googleId, email, picture}
 * @param {object} currentUser modelo User da sessão
 * @returns {Promise<{user, alreadyLinked:boolean}>}
 * @throws {GoogleAuthError}
 */
async function linkGoogleAccount(googleInfo, currentUser) {
  if (!googleInfo || !googleInfo.googleId || !googleInfo.email) {
    throw new GoogleAuthError('Informações do Google indisponíveis.', 401, 'INVALID_IDENTITY');
  }
  if (!currentUser || !currentUser._id) {
    throw new GoogleAuthError('Faça login para vincular sua conta Google.', 401, 'UNAUTHENTICATED');
  }

  if (currentUser.googleId === googleInfo.googleId) {
    return { user: currentUser, alreadyLinked: true };
  }

  const ownedBy = await User.findByGoogleId(googleInfo.googleId);
  if (ownedBy && ownedBy._id !== currentUser._id) {
    throw new GoogleAuthError(
      'Esta conta Google já está vinculada a outro usuário.',
      409,
      'GOOGLE_ID_OWNED'
    );
  }

  const existingByEmail = await User.findByEmail(googleInfo.email);
  if (existingByEmail && existingByEmail._id !== currentUser._id) {
    throw new GoogleAuthError(
      'Este e-mail já está vinculado a outra conta.',
      409,
      'EMAIL_OWNED'
    );
  }

  const updated = await User.findByIdAndUpdate(currentUser._id, {
    googleId: googleInfo.googleId,
    // NUNCA sobrescreve um avatar personalizado existente (regra da
    // migração): o picture do Google fica armazenado à parte em
    // googleAvatarUrl e o avatar efetivo vira avatar || googleAvatarUrl.
    googleAvatarUrl: googleInfo.picture || null,
  });

  return { user: updated || currentUser, alreadyLinked: false };
}

/**
 * DESVÍNCULO Google — bloqueado quando a conta NÃO tem outro método de
 * autenticação válido (conta criada via Google: googleId + senha aleatória
 * que nunca foi conhecida → desvincular a deixaria sem acesso).
 *
 * @param {string} userId
 * @returns {Promise<{unlinked:boolean}>}
 * @throws {GoogleAuthError}
 */
async function unlinkGoogleAccount(userId) {
  const user = await User.findByIdWithSensitive(userId);
  if (!user) {
    throw new GoogleAuthError('Usuário não encontrado.', 404, 'USER_NOT_FOUND');
  }
  if (user.authProvider === 'google' || !user.password) {
    throw new GoogleAuthError(
      'Sua conta usa o login pelo Google. Para desvincular, é necessário outro método de autenticação válido.',
      409,
      'UNLINK_BLOCKED'
    );
  }
  await User.findByIdAndUpdate(userId, {
    googleId: null,
    // Ao desvincular, o picture do Google deixa de ser fonte de avatar.
    googleAvatarUrl: null,
  });
  return { unlinked: true };
}

async function generateSessionToken(user) {
  return jwt.sign(
    {
      id: user._id,
      email: user.email,
      role: user.role,
      sv: user.sessionVersion || 0,
    },
    config.jwt.secret,
    { expiresIn: config.jwt.expiresIn }
  );
}

const googleAuthService = {
  getGoogleUserInfo,
  exchangeCodeForToken,
  loginWithGoogle,
  registerWithGoogle,
  linkGoogleAccount,
  unlinkGoogleAccount,
  generateSessionToken,
  GoogleAuthError,
};

module.exports = googleAuthService;