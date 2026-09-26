/**
 * SvenTV API - Rotas de Autenticação
 *
 * POST /auth/register         → Criar conta
 * POST /auth/login            → Login
 * POST /auth/logout           → Logout
 * GET  /auth/profile          → Ver perfil + API token (requer sessão)
 * PUT  /auth/profile          → Atualizar perfil (requer sessão)
 * POST /auth/change-password  → Trocar senha (requer sessão)
 * POST /auth/regenerate-token → Regenerar API token (requer sessão)
 */

'use strict';

const { Router } = require('express');
const authController = require('../controllers/authController');
const { requireSessionAuth } = require('../middlewares/auth');
const { loginLimiter, registerLimiter, forgotPasswordLimiter, resetPasswordLimiter } = require('../middlewares/rateLimiter');
const { validate } = require('../middlewares/validate');

const router = Router();

// Observação de arquitetura: LOGIN e CADASTRO Google NÃO seguem por aqui.
// O fluxo "intenção explícita" vive em `/api/google/*` (googleRoutes.js) —
// login do Google NUNCA cria conta; cadastro é endpoint dedicado.

// ── Rotas públicas ────────────────────────────────────────────

router.post(
  '/register',
  registerLimiter,
  validate('register'),
  authController.register
);

router.post(
  '/login',
  loginLimiter,
  validate('login'),
  authController.login
);

// ── Recuperação de senha (públicas) ───────────────────────────

router.post(
  '/forgot-password',
  forgotPasswordLimiter,
  validate('forgotPassword'),
  authController.forgotPassword
);

router.post(
  '/reset-password',
  resetPasswordLimiter,
  validate('resetPassword'),
  authController.resetPassword
);

// ── Rotas protegidas (exigem sessão ativa) ────────────────────

/**
 * @route  POST /auth/logout
 * @desc   Encerra a sessão do usuário
 * @access Privado
 */
router.post('/logout', requireSessionAuth, authController.logout);

/**
 * @route  GET /auth/profile
 * @desc   Retorna perfil e API token do usuário autenticado
 * @access Privado
 */
router.get('/profile', requireSessionAuth, authController.getProfile);

/**
 * @route  GET /auth/api-token
 * @desc   Retorna APENAS o API token do usuário autenticado.
 *         Usado pela página de perfil sob demanda (clique em "Mostrar"),
 *         evitando injetar o token no HTML renderizado.
 * @access Privado
 */
router.get('/api-token', requireSessionAuth, authController.revealApiToken);

/**
 * @route  PUT /auth/profile
 * @desc   Atualiza nome e/ou avatar (URL externa HTTPS; avatar:'' limpa)
 * @access Privado
 */
router.put(
  '/profile',
  requireSessionAuth,
  validate('updateProfile'),
  authController.updateProfile
);

/**
 * @route  POST /auth/change-password
 * @desc   Altera a senha da conta
 * @access Privado
 */
router.post(
  '/change-password',
  requireSessionAuth,
  validate('changePassword'),
  authController.changePassword
);

/**
 * @route  POST /auth/regenerate-token
 * @desc   Revoga e regenera o API token exclusivo do usuário
 * @access Privado
 */
router.post('/regenerate-token', requireSessionAuth, authController.regenerateApiToken);

module.exports = router;
