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
 * @desc  Filmes + séries + programações ao vivo em alta (carrosséis da dashboard)
 * @access Privado — session OU API token
 */
router.get('/', ...guard, trendingController.list);

/**
 * @route GET /api/trending/movies
 * @desc  Top 10 filmes mais assistidos (period: 7)
 */
router.get('/movies', ...guard, trendingController.getMovies);

/**
 * @route GET /api/trending/series
 * @desc  Top 10 séries mais assistidas (period: 7)
 */
router.get('/series', ...guard, trendingController.getSeries);

/**
 * @route GET /api/trending/channels
 * @desc  Programações ao vivo mais assistidas no momento
 */
router.get('/channels', ...guard, trendingController.getChannels);

module.exports = router;