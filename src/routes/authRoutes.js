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
const multer = require('multer');
const authController = require('../controllers/authController');
const { requireSessionAuth } = require('../middlewares/auth');
const { loginLimiter, registerLimiter } = require('../middlewares/rateLimiter');
const { validate } = require('../middlewares/validate');

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// ── Rotas públicas ────────────────────────────────────────────

/**
 * @route  POST /auth/register
 * @desc   Cria uma nova conta de usuário
 * @access Público
 */
router.post(
  '/register',
  registerLimiter,
  validate('register'),
  authController.register
);

/**
 * @route  POST /auth/login
 * @desc   Autentica o usuário e retorna tokens
 * @access Público
 */
router.post(
  '/login',
  loginLimiter,
  validate('login'),
  authController.login
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
 * @desc   Atualiza nome e/ou avatar
 * @access Privado
 */
router.put(
  '/profile',
  requireSessionAuth,
  validate('updateProfile'),
  authController.updateProfile
);

/**
 * @route  POST /auth/avatar
 * @desc   Upload do avatar (arquivo ou URL remota)
 * @access Privado
 */
router.post(
  '/avatar',
  requireSessionAuth,
  upload.single('avatar'),
  authController.uploadAvatar
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
