/**
 * SvenTV API — User Controller
 *
 * Área pessoal: histórico, dashboard, recomendações e playlists.
 * Todas as rotas usam requireSessionOrApi (session OU API token) e NUNCA
 * confiam em ids do corpo/URL para ownership — o userId autenticado vira
 * de req.user e é sempre passado aos serviços.
 */

'use strict';

const M3UService = require('../services/m3uService');
const { getHistory, getRecentHistory } = require('../services/playbackService');
const { getRecommendations } = require('../services/recommendationService');
const playlistService = require('../services/playlistService');

const m3uService = M3UService.getShared();

const channelOf = (req, channelId) => {
  const channel = m3uService.getChannelById(channelId);
  if (!channel) {
    const e = new Error('Canal não encontrado.');
    e.statusCode = 404;
    e.code = 'NOT_FOUND';
    throw e;
  }
  return channel;
};

const userController = {
  /**
   * GET /api/dashboard
   * Agrega tudo que o painel precisa em UMA chamada:
   * histórico recente, playlists e recomendações com razões.
   */
  async getDashboard(req, res, next) {
    try {
      const userId = req.user.id;
      const [history, playlists, recommendations] = await Promise.all([
        getRecentHistory(userId),
        playlistService.listPlaylists(userId, { limit: 8 }),
        getRecommendations(userId),
      ]);

      return res.status(200).json({
        success: true,
        data: { history, playlists: playlists.items, recommendation: recommendations, },
      });
    } catch (error) {
      return next(error);
    }
  },

  /**
   * GET /api/user/history?limit=&cursor=
   */
  async getHistory(req, res, next) {
    try {
      const { limit, cursor } = req.query;
      const data = await getHistory(req.user.id, { limit, cursor });
      return res.status(200).json({ success: true, data });
    } catch (error) {
      return next(error);
    }
  },

  /**
   * GET /api/user/recommendations?limit=
   */
  async getRecommendations(req, res, next) {
    try {
      const data = await getRecommendations(req.user.id, { limit: req.query.limit });
      return res.status(200).json({ success: true, data });
    } catch (error) {
      return next(error);
    }
  },

  // ─── Playlists ─────────────────────────────────────────────

  /**
   * GET /api/user/playlists?page=&limit=
   */
  async listPlaylists(req, res, next) {
    try {
      const data = await playlistService.listPlaylists(req.user.id, req.query);
      return res.status(200).json({ success: true, data });
    } catch (error) {
      return next(error);
    }
  },

  /**
   * GET /api/user/playlists/:playlistId
   */
  async getPlaylist(req, res, next) {
    try {
      const data = await playlistService.getPlaylist(req.user.id, req.params.playlistId);
      return res.status(200).json({ success: true, data });
    } catch (error) {
      return next(error);
    }
  },

  /**
   * GET /api/user/playlists/:playlistId/channels?limit=&offset=
   */
  async listPlaylistChannels(req, res, next) {
    try {
      const data = await playlistService.listPlaylistChannels(
        req.user.id,
        req.params.playlistId,
        req.query
      );
      return res.status(200).json({ success: true, data });
    } catch (error) {
      return next(error);
    }
  },

  /**
   * GET /api/user/playlists/status/:channelId
   * Diz se o canal já está salvo e em qual playlist (para o modal).
   */
  async getChannelSavedState(req, res, next) {
    try {
      const data = await playlistService.findPlaylistForChannel(req.user.id, req.params.channelId);
      return res.status(200).json({ success: true, data });
    } catch (error) {
      return next(error);
    }
  },

  /**
   * POST /api/user/playlists
   */
  async createPlaylist(req, res, next) {
    try {
      const data = await playlistService.createPlaylist(req.user.id, req.body);
      return res.status(201).json({ success: true, data });
    } catch (error) {
      return next(error);
    }
  },

  /**
   * PUT /api/user/playlists/:playlistId
   */
  async updatePlaylist(req, res, next) {
    try {
      const data = await playlistService.updatePlaylist(req.user.id, req.params.playlistId, req.body);
      return res.status(200).json({ success: true, data });
    } catch (error) {
      return next(error);
    }
  },

  /**
   * DELETE /api/user/playlists/:playlistId
   */
  async deletePlaylist(req, res, next) {
    try {
      const data = await playlistService.deletePlaylist(req.user.id, req.params.playlistId);
      return res.status(200).json({ success: true, data });
    } catch (error) {
      return next(error);
    }
  },

  /**
   * POST /api/user/playlists/:playlistId/channels
   * Body: { channelId }. Garante a regra 1 canal = 1 playlist por usuário.
   */
  async addChannel(req, res, next) {
    try {
      const channel = channelOf(req, req.body.channelId);
      const data = await playlistService.addChannel(req.user.id, req.params.playlistId, channel.id, channel);
      return res.status(201).json({ success: true, data });
    } catch (error) {
      return next(error);
    }
  },

  /**
   * DELETE /api/user/playlists/:playlistId/channels/:channelId
   */
  async removeChannel(req, res, next) {
    try {
      const data = await playlistService.removeChannel(req.user.id, req.params.playlistId, req.params.channelId);
      return res.status(200).json({ success: true, data });
    } catch (error) {
      return next(error);
    }
  },

  /**
   * POST /api/user/playlists/create-with-channel
   * Body: { name, description?, channelId } — cria a playlist e já salva
   * o canal em transação (sem estado parcial se o canal violar a regra).
   */
  async createPlaylistWithChannel(req, res, next) {
    try {
      const channel = channelOf(req, req.body.channelId);
      const { name, description } = req.body;
      const data = await playlistService.createPlaylistWithChannel(req.user.id, { name, description }, channel.id, channel);
      return res.status(201).json({ success: true, data });
    } catch (error) {
      return next(error);
    }
  },
};

module.exports = userController;