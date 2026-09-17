/**
 * SvenTV API — Playback Controller
 *
 * Expõe a ingestão de eventos de reprodução (transições discretas e
 * heartbeat) para o player web e clientes externos.
 *
 * Auth: requireEventAuth (session | api | playback token do canal).
 * Sem excessão de sanitizeXss — o body chega escapado, mas IDs são
 * sha1 hex e sobrevivem intactos à validação Joi.
 */

'use strict';

const playbackService = require('../services/playbackService');
const M3UService = require('../services/m3uService');

const m3uService = M3UService.getShared();

const playbackController = {
  /**
   * POST /api/playback/events
   * Transição discreta: play | pause | resume | stop | ended.
   */
  async ingestEvent(req, res, next) {
    try {
      // Metadata do canal (nome/logo/categoria) entra no snapshot da
      // sessão/histórico se o canal ainda existe no M3U — nunca a URL.
      const channel = m3uService.getChannelById(req.body.channelId);

      const result = await playbackService.ingestEvent({
        userId: req.user.id,
        channelId: req.body.channelId,
        sessionId: req.body.sessionId,
        event: req.body.event,
        watchDurationMs: req.body.watchDurationMs,
        channelMeta: channel,
      });

      if (!result.ok) {
        if (result.code === 'SESSION_OWNERSHIP') {
          return res.status(403).json({
            success: false,
            code: result.code,
            message: 'Esta sessão de reprodução pertence a outro usuário.',
          });
        }
        if (result.code === 'NO_SESSION') {
          return res.status(404).json({
            success: false,
            code: result.code,
            message: result.message || 'Sessão de reprodução não encontrada.',
          });
        }
        if (result.code === 'ALREADY_FINALIZED') {
          return res.status(200).json({ success: true, code: result.code, data: result });
        }
        return res.status(422).json({ success: false, code: result.code, message: 'Evento não processado.' });
      }

      return res.status(200).json({ success: true, data: result });
    } catch (error) {
      return next(error);
    }
  },

  /**
   * POST /api/playback/heartbeat
   * Atualiza watch time da sessão ativa (não grava linha de evento).
   */
  async heartbeat(req, res, next) {
    try {
      const result = await playbackService.heartbeat({
        userId: req.user.id,
        sessionId: req.body.sessionId,
        watchDurationMs: req.body.watchDurationMs,
      });

      if (!result.ok) {
        if (result.code === 'NO_SESSION') {
          return res.status(404).json({
            success: false,
            code: result.code,
            message: 'Sessão de reprodução não encontrada.',
          });
        }
        // INACTIVE: sessão finalizada/pausada — o player deve reiniciar
        // com um novo "play". Respondemos 200 para o player sincronizar.
        if (result.code === 'INACTIVE') {
          return res.status(200).json({ success: true, data: result });
        }
        return res.status(422).json({ success: false, code: result.code, message: 'Heartbeat não processado.' });
      }

      return res.status(200).json({ success: true, data: result });
    } catch (error) {
      return next(error);
    }
  },
};

module.exports = playbackController;