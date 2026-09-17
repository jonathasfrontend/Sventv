'use strict';
const TrendingService = require('../services/trendingService');

/**
 * Controller de Tendências (Top 10 do catálogo).
 *
 * Só alimenta a dashboard com metadados públicos (título, imagem de catálogo,
 * gênero/duração) — nunca URLs de stream. Mesmo contrato dos demais endpoints:
 * `{ success, message, data }`. Feature desligada (TRENDING_ENABLED=false) ou
 * provedor indisponível → lista vazia com success:true (fail-open; o frontend
 * esconde o carrossel), nunca 500.
 */
class TrendingController {
  constructor() {
    this.trendingService = TrendingService.getShared();
  }

  /**
   * GET /api/trending
   * Retorna filmes, séries e canais em UMA chamada (carrosséis da dashboard).
   */
  list = async (_req, res) => {
    try {
      await this.trendingService.ensureLoaded();
      const snapshot = this.trendingService.getSnapshot();

      return res.status(200).json({
        success: true,
        message: 'Tendências carregadas com sucesso',
        data: snapshot,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      // Fail-open: nunca vira 500 por causa de provedor de metadados.
      console.error('Erro ao obter tendências:', error.message);
      return res.status(200).json({
        success: true,
        message: 'Tendências temporariamente indisponíveis',
        data: emptySnapshot(),
        timestamp: new Date().toISOString(),
      });
    }
  };

  /**
   * GET /api/trending/movies
   */
  getMovies = async (_req, res) => {
    try {
      await this.trendingService.ensureLoaded();
      const movies = this.trendingService.getMovies();
      return res.status(200).json({
        success: true,
        message: 'Filmes em alta carregados com sucesso',
        data: { total: movies.length, movies },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error('Erro ao obter filmes em alta:', error.message);
      return res.status(200).json({
        success: true,
        message: 'Filmes em alta temporariamente indisponíveis',
        data: { total: 0, movies: [] },
        timestamp: new Date().toISOString(),
      });
    }
  };

  /**
   * GET /api/trending/series
   */
  getSeries = async (_req, res) => {
    try {
      await this.trendingService.ensureLoaded();
      const series = this.trendingService.getSeries();
      return res.status(200).json({
        success: true,
        message: 'Séries em alta carregadas com sucesso',
        data: { total: series.length, series },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error('Erro ao obter séries em alta:', error.message);
      return res.status(200).json({
        success: true,
        message: 'Séries em alta temporariamente indisponíveis',
        data: { total: 0, series: [] },
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
      console.error('Erro ao obter programações em alta:', error.message);
      return res.status(200).json({
        success: true,
        message: 'Programações em alta temporariamente indisponíveis',
        data: { total: 0, channels: [] },
        timestamp: new Date().toISOString(),
      });
    }
  };
}

function emptySnapshot() {
  return { fetchedAt: null, cached: false, total: { movies: 0, series: 0, channels: 0 }, movies: [], series: [], channels: [] };
}

module.exports = TrendingController;