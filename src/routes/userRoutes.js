'use strict';

const { Router } = require('express');
const userController = require('../controllers/userController');
const reminderController = require('../controllers/reminderController');
const { requireSessionOrApi } = require('../middlewares/auth');
const { userLimiter } = require('../middlewares/rateLimiter');
const { validate } = require('../middlewares/validate');

const router = Router();

// Guarda padrão: session token do painel OU API token de aplicações.
// Ownership sempre deriva de req.user.id — nunca de ids do body/URL.
const guard = [requireSessionOrApi, userLimiter];

/**
 * @route GET /api/dashboard
 * @desc  Histórico recente + playlists + recomendações com razões
 * @access Privado — session OU API token
 */
router.get('/dashboard', ...guard, userController.getDashboard);

/**
 * @route GET /api/user/history?limit=&cursor=
 * @desc  Histórico consolidado (paginação cursor-based por lastPlayedAt)
 */
router.get('/user/history', ...guard, userController.getHistory);

/**
 * @route GET /api/user/recommendations?limit=
 * @desc  Recomendações explicáveis ("Por que você assistiu isso?")
 */
router.get('/user/recommendations', ...guard, userController.getRecommendations);

// ─── Playlists ───────────────────────────────────────────────

router.get('/user/playlists', ...guard, userController.listPlaylists);
router.get('/user/playlists/status/:channelId', ...guard, userController.getChannelSavedState);
router.post('/user/playlists', ...guard, validate('createPlaylist'), userController.createPlaylist);
router.post(
  '/user/playlists/create-with-channel',
  ...guard,
  validate('createPlaylistWithChannel'),
  userController.createPlaylistWithChannel
);
router.get('/user/playlists/:playlistId', ...guard, userController.getPlaylist);
router.put('/user/playlists/:playlistId', ...guard, validate('updatePlaylist'), userController.updatePlaylist);
router.delete('/user/playlists/:playlistId', ...guard, userController.deletePlaylist);
router.get('/user/playlists/:playlistId/channels', ...guard, userController.listPlaylistChannels);
router.post(
  '/user/playlists/:playlistId/channels',
  ...guard,
  validate('addPlaylistChannel'),
  userController.addChannel
);
router.delete(
  '/user/playlists/:playlistId/channels/:channelId',
  ...guard,
  userController.removeChannel
);

// ─── Avise-me (lembretes de programação) ─────────────────────
// Lembretes são dados pessoais: ownership SEMPRE via req.user.id (já
// garantido pela guarda). A confirmação de disparo (two-phase) é idempotente.

router.get('/user/reminders', ...guard, reminderController.list);
router.post('/user/reminders', ...guard, validate('createReminder'), reminderController.create);
router.get('/user/reminders/status', ...guard, reminderController.status);
router.post('/user/reminders/:id/notified', ...guard, reminderController.markNotified);
router.delete('/user/reminders/:id', ...guard, reminderController.remove);

module.exports = router;