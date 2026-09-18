'use strict';

const express = require('express');
const EPGController = require('../controllers/epgController');
const { requireApiAuth } = require('../middlewares/auth');
const { apiLimiter } = require('../middlewares/rateLimiter');

const router = express.Router();
const epgController = new EPGController();

/**
 * Guia de Programação (EPG)
 *
 * Ambas as rotas exigem API token (mesma guarda das demais rotas REST) e
 * passam pelo apiLimiter. O endpoint é read-only e NUNCA expõe EPG_URL.
 */

// GET /api/epg — lista canais casados com EPG + programa atual/próximo
router.get('/', requireApiAuth, apiLimiter, epgController.listGuide);

// GET /api/epg/grid — grade por janela para o grid do guia de TV
// (registrada ANTES de /:channelId para "grid" não ser capturada como id).
router.get('/grid', requireApiAuth, apiLimiter, epgController.gridGuide);

// GET /api/epg/search — busca combinada (canais + programação inteira).
// Também antes de /:channelId ("search" não pode virar id de canal).
router.get('/search', requireApiAuth, apiLimiter, epgController.search);

// GET /api/epg/:channelId — grade completa de programação de um canal
router.get('/:channelId', requireApiAuth, apiLimiter, epgController.getChannelGuide);

module.exports = router;