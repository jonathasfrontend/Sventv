'use strict';

const { Router } = require('express');
const playbackController = require('../controllers/playbackController');
const { requireEventAuth } = require('../middlewares/auth');
const { eventsLimiter } = require('../middlewares/rateLimiter');
const { validate } = require('../middlewares/validate');

const router = Router();

// Ingestão de eventos de reprodução (transições + heartbeat).
// Aceita session | api | playback token do canal. Limitador próprio —
// heartbeats de 30s não podem ser cortados pelas cotas REST/stream.
router.post(
  '/events',
  requireEventAuth,
  eventsLimiter,
  validate('playbackEvent'),
  playbackController.ingestEvent
);

router.post(
  '/heartbeat',
  requireEventAuth,
  eventsLimiter,
  validate('heartbeat'),
  playbackController.heartbeat
);

module.exports = router;