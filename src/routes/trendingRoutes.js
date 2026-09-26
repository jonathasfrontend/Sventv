'use strict';

const { Router } = require('express');
const TrendingController = require('../controllers/trendingController');
const { requireSessionOrApi } = require('../middlewares/auth');
const { userLimiter } = require('../middlewares/rateLimiter');

const router = Router();
const trendingController = new TrendingController();

// Guarda padrão da área pessoal: session token do painel (cookie httpOnly)
// OU API token de aplicações. Endpoint é read-only e NUNCA expõe a URL do
// provedor de metadados nem qualquer URL de stream.
const guard = [requireSessionOrApi, userLimiter];

/**
 * @route GET /api/trending
 * @desc  Programações ao vivo em alta (carrossel "Ao vivo em alta" da dashboard)
 * @access Privado — session OU API token
 */
router.get('/', ...guard, trendingController.list);

/**
 * @route GET /api/trending/channels
 * @desc  Programações ao vivo mais assistidas no momento
 */
router.get('/channels', ...guard, trendingController.getChannels);

module.exports = router;