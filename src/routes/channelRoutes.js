'use strict';

const express = require('express');
const ChannelController = require('../controllers/channelController');
const { requireApiAuth, requireRole } = require('../middlewares/auth');
const { apiLimiter, streamLimiter } = require('../middlewares/rateLimiter');
const { antiHotlink } = require('../middlewares/security');

const router = express.Router();
const channelController = new ChannelController();

// Aplica autenticação via API token e rate limiter em todas as rotas abaixo
router.use(requireApiAuth);
router.use(apiLimiter);

/**
 * @route  GET /api/channels
 * @desc   Retorna todos os canais disponíveis
 * @access Privado — requer API token
 */
router.get('/', channelController.getAllChannels);

/**
 * @route  GET /api/channels/stats
 * @desc   Retorna estatísticas dos canais
 * @access Privado — requer API token
 */
router.get('/stats', channelController.getStats);

/**
 * @route GET /api/channels/statuses
 * @desc  Retorna status dos canais (checados pelo serviço)
 * @access Admin
 */
router.get('/statuses', requireRole('admin'), channelController.getStatuses);

/**
 * @route  GET /api/channels/categories
 * @desc   Retorna todas as categorias disponíveis
 * @access Privado — requer API token
 */
router.get('/categories', channelController.getCategories);

/**
 * @route  GET /api/channels/search?q=termo
 * @desc   Busca canais por nome ou categoria
 * @access Privado — requer API token
 */
router.get('/search', channelController.searchChannels);

/**
 * @route  GET /api/channels/category/:category
 * @desc   Retorna canais de uma categoria específica
 * @access Privado — requer API token
 */
router.get('/category/:category', channelController.getChannelsByCategory);

/**
 * @route  GET /api/channels/:id
 * @desc   Retorna informações de um canal específico
 * @access Privado — requer API token
 */
router.get('/:id', channelController.getChannelById);

/**
 * Checagem on-demand de um canal (admin)
 */
router.post('/:id/check', requireRole('admin'), channelController.checkChannel);

/**
 * @route  GET /api/channels/:id/stream
 * @desc   Retorna o player de vídeo do canal para iframe
 * @access Privado — requer API token + proteção anti-hotlink
 */
router.get(
	'/:id/stream',
	streamLimiter,
	antiHotlink,
	channelController.getChannelStream
);

/**
 * @route  POST /api/channels/reload
 * @desc   Recarrega a lista de canais do arquivo M3U
 * @access Admin apenas
 */
router.post('/reload', requireRole('admin'), channelController.reloadChannels);

module.exports = router;
