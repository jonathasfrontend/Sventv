'use strict';
const TrendingService = require('../services/trendingService');

/**
 * Controller de Tendências — SOMENTE programações ao vivo em alta.
 *
 * Só alimenta a dashboard com metadados públicos (título, canal, gênero e a
 * arte da programação) — nunca URLs de stream. Mesmo contrato dos demais
 * endpoints: `{ success, message, data }`. Feature desligada
 * (TRENDING_ENABLED=false) ou provedor indisponível → lista vazia com
 * success:true (fail-open; o frontend esconde o carrossel), nunca 500.
 */
class TrendingController {
  constructor() {
    this.trendingService = TrendingService.getShared();
  }

  /**
   * GET /api/trending
   * Retorna as programações ao vivo em alta em UMA chamada (carrossel da
   * dashboard).
   */
  list = async (_req, res) => {
    try {
      await this.trendingService.ensureLoaded();
      const snapshot = this.trendingService.getSnapshot();

      return res.status(200).json({
        success: true,
        message: 'Programações ao vivo em alta carregadas com sucesso',
        data: snapshot,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      // Fail-open: nunca vira 500 por causa de provedor de metadados.
      console.error('Erro ao obter programações ao vivo em alta:', error.message);
      return res.status(200).json({
        success: true,
        message: 'Programações ao vivo em alta temporariamente indisponíveis',
        data: emptySnapshot(),
        timestamp: new Date().toISOString(),
      });
    }
  };

  /**
   * GET /api/trending/channels
   */
  getChannels = async (_req, res) => {
    try {
      await this.trendingService.ensureLoaded();
      const channels = this.trendingService.getChannels();
      return res.status(200).json({
        success: true,
        message: 'Programações ao vivo em alta carregadas com sucesso',
        data: { total: channels.length, channels },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error('Erro ao obter programações ao vivo em alta:', error.message);
      return res.status(200).json({
        success: true,
        message: 'Programações ao vivo em alta temporariamente indisponíveis',
        data: { total: 0, channels: [] },
        timestamp: new Date().toISOString(),
      });
    }
  };
}

function emptySnapshot() {
  return { fetchedAt: null, cached: false, total: { channels: 0 }, channels: [] };
}

module.exports = TrendingController;