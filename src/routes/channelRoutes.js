'use strict';

const express = require('express');
const ChannelController = require('../controllers/channelController');
const { requireApiAuth, requireStreamAccess, requireRole } = require('../middlewares/auth');
const { apiLimiter, streamLimiter, proxyStreamLimiter } = require('../middlewares/rateLimiter');
const { antiHotlink } = require('../middlewares/security');

const router = express.Router();
const channelController = new ChannelController();

// Guarda padrão das rotas REST de canal: API token + limiter por plano.
// As rotas /stream e /proxy usam guarda própria (API OU playback token)
// e limiters dedicados — NÃO devem consumir a cota REST do usuário.
const restGuard = [requireApiAuth, apiLimiter];

/**
 * @route  GET /api/channels
 * @desc   Retorna todos os canais disponíveis (sem url/source)
 * @access Privado — requer API token
 */
router.get('/', ...restGuard, channelController.getAllChannels);

/**
 * @route  GET /api/channels/stats
 * @desc   Retorna estatísticas dos canais
 * @access Privado — requer API token
 */
router.get('/stats', ...restGuard, channelController.getStats);

/**
 * @route GET /api/channels/statuses
 * @desc  Retorna status dos canais (checados pelo serviço)
 * @access Admin
 */
router.get('/statuses', ...restGuard, requireRole('admin'), channelController.getStatuses);

/**
 * @route  GET /api/channels/categories
 * @desc   Retorna todas as categorias disponíveis
 * @access Privado — requer API token
 */
router.get('/categories', ...restGuard, channelController.getCategories);

/**
 * @route  GET /api/channels/search?q=termo
 * @desc   Busca canais por nome ou categoria
 * @access Privado — requer API token
 */
router.get('/search', ...restGuard, channelController.searchChannels);

/**
 * @route  GET /api/channels/category/:category
 * @desc   Retorna canais de uma categoria específica
 * @access Privado — requer API token
 */
router.get('/category/:category', ...restGuard, channelController.getChannelsByCategory);

/**
 * @route  GET /api/channels/:id
 * @desc   Retorna informações de um canal específico (sem url/source)
 * @access Privado — requer API token
 */
router.get('/:id', ...restGuard, channelController.getChannelById);

/**
 * Checagem on-demand de um canal (admin)
 */
router.post('/:id/check', ...restGuard, requireRole('admin'), channelController.checkChannel);

/**
 * @route  POST /api/channels/:id/playback
 * @desc   Emite playback token de curta duração (2h) válido apenas para este canal
 * @access Privado — requer API token
 */
router.post('/:id/playback', ...restGuard, channelController.requestPlayback);

/**
 * @route  GET /api/channels/:id/stream
 * @desc   Retorna o player de vídeo do canal para iframe
 * @access Privado — requer API token OU playback token deste canal + anti-hotlink
 */
router.get(
	'/:id/stream',
	requireStreamAccess,
	streamLimiter,
	antiHotlink,
	channelController.getChannelStream
);

/**
 * @route  GET /api/channels/:id/proxy
 * @desc   Proxy HTTPS de playlists HLS e segmentos (evita Mixed Content).
 *         Sub-recursos referenciados por blob selado ?p= (sem URL upstream no cliente).
 * @access Privado — requer API token OU playback token deste canal
 */
router.get(
	'/:id/proxy',
	requireStreamAccess,
	proxyStreamLimiter,
	antiHotlink,
	channelController.streamProxy
);

/**
 * @route  POST /api/channels/reload
 * @desc   Recarrega a lista de canais do arquivo M3U
 * @access Admin apenas
 */
router.post('/reload', ...restGuard, requireRole('admin'), channelController.reloadChannels);

module.exports = router;
