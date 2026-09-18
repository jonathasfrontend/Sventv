'use strict';
const EPGService = require('../services/epgService');
const M3UService = require('../services/m3uService');
const { toPublicChannel } = require('../utils/publicChannel');
const { inc } = require('../utils/metrics');
const { splitTimeToken } = require('../utils/searchNormalize');

/**
 * Controller do Guia de Programação (EPG).
 *
 * O EPG nunca revela a origem (EPG_URL) e nunca inventa dados: canais sem
 * match são descartados na fonte (epgService) e, aqui, o que não tem
 * programação no trecho volta com now/next null ("Programação indisponível"
 * é tratado no frontend, não como ausência de canal).
 */
class EPGController {
  constructor() {
    this.epgService = EPGService.getShared();
    this.m3uService = M3UService.getShared();
  }

  /**
   * GET /api/epg
   * Lista TODOS os canais da M3U (a guia nunca esconde canal da lista
   * oficial), cada um com o programa atual e o próximo quando há match EPG
   * (senão now/next null = "Programação indisponível"). Nunca expõe a EPG_URL.
   */
  listGuide = async (req, res) => {
    try {
      if (!this.epgService.isEnabled()) {
        return res.status(200).json({
          success: true,
          message: 'Guia de canais desativado (EPG_ENABLED=false)',
          data: { total: 0, channels: [] },
          timestamp: new Date().toISOString(),
        });
      }

      // Cold start: garante pelo menos um fetch em andamento; nunca rejeita.
      await this.epgService.ensureLoaded();

      const now = Date.now();
      const m3uChannels = this.m3uService.getAllChannels();
      const channels = [];

      for (const channel of m3uChannels) {
        const publicChannel = toPublicChannel(channel);
        const epgChannelId = this.epgService.getEpgChannelId(channel.id);
        // Canais sem match EPG aparecem com now/next null (programação
        // indisponível) — não somem da guia.
        const nn = epgChannelId ? this.epgService.getNowNext(channel.id, now) : null;
        channels.push({
          ...publicChannel,
          epgChannelId,
          now: nn ? toPublicProgramme(nn.current) : null,
          next: nn ? toPublicProgramme(nn.next) : null,
        });
      }

      return res.status(200).json({
        success: true,
        message: 'Guia de canais carregado com sucesso',
        data: { total: channels.length, channels },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error('Erro ao listar guia de canais:', error);
      return res.status(500).json({
        success: false,
        message: 'Erro interno do servidor',
        data: null,
        timestamp: new Date().toISOString(),
      });
    }
  };

  /**
   * GET /api/epg/search?q=&tz=&limitChannels=&limitProgrammes=
   * Busca combinada em TODA a programação (não só na janela do grid):
   * devolve canais da M3U cujo nome/categoria casa o texto + programas do
   * EPG que casam texto E/OU horário. Horários são resolvidos no fuso do
   * cliente via `tz` (offset em minutos, default 0) — o cliente pode mandar
   * "20h" e esperar programações das 20h do SEU relógio. Resultados são
   * agrupados e sempre passam por toPublicChannel (nunca vazam URL/segredo).
   */
  search = async (req, res) => {
    try {
      if (!this.epgService.isEnabled()) {
        return res.status(200).json({
          success: true,
          message: 'Guia de canais desativado (EPG_ENABLED=false)',
          data: { q: '', channels: [], programmes: [] },
          timestamp: new Date().toISOString(),
        });
      }

      const q = String((req.query && req.query.q) || '').trim().slice(0, 100);
      const { time, text } = splitTimeToken(q);
      // Válida se há texto útil OU token de horário ("20h" sozinho é válido).
      const hasContent = q.length > 0 && (time != null || text.length > 0);

      if (!hasContent) {
        return res.status(422).json({
          success: false,
          message: 'Informe um termo de busca (e.g. "futebol", "20h" ou "jornal 20h30").',
          data: null,
          timestamp: new Date().toISOString(),
        });
      }

      const rawTz = Number(req.query && req.query.tz);
      const tzOffsetMinutes = Number.isFinite(rawTz) ? Math.max(-840, Math.min(840, Math.round(rawTz))) : 0;
      const limitChannels = clampLimit(req.query.limitChannels, 50, 100);
      const limitProgrammes = clampLimit(req.query.limitProgrammes, 100, 200);

      await this.epgService.ensureLoaded();

      inc('guideSearches');
      const { channels: found, programmes } = this.epgService.search(q, {
        limitChannels,
        limitProgrammes,
        tzOffsetMinutes,
      });

      const channels = found.map((ch) => this._publicWithMatch(ch)).filter(Boolean);

      const programmeRows = [];
      for (const p of programmes) {
        const channel = this.m3uService.getChannelById(p.channelId);
        if (!channel) continue;
        programmeRows.push({
          ...toPublicProgramme(p),
          channelId: p.channelId,
          channelName: channel.cleanName || channel.name || '',
          channelLogo: channel.logo || '',
          channelCategory: channel.category || '',
        });
      }

      return res.status(200).json({
        success: true,
        message: 'Busca do guia concluída com sucesso',
        data: { q, channels, programmes: programmeRows, total: programmeRows.length },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error('Erro na busca do guia:', error);
      return res.status(500).json({
        success: false,
        message: 'Erro interno do servidor',
        data: null,
        timestamp: new Date().toISOString(),
      });
    }
  };

  /**
   * Canal público + estado de match EPG (mesmo shape do listGuide).
   */
  _publicWithMatch(channel) {
    if (!channel) return null;
    const publicChannel = toPublicChannel(channel);
    return {
      ...publicChannel,
      epgChannelId: this.epgService.getEpgChannelId(channel.id) || null,
      hasEpg: Boolean(this.epgService.getEpgChannelId(channel.id)),
    };
  }

  /**
   * GET /api/epg/:channelId
   * Grade completa de programação de um canal com match EPG (janela inteira
   * disponível no XML). 404 quando o canal não tem EPG casado.
   */
  getChannelGuide = async (req, res) => {
    try {
      const { channelId } = req.params;

      if (!this.epgService.isEnabled()) {
        return res.status(404).json({
          success: false,
          message: 'Guia de canais desativado (EPG_ENABLED=false)',
          data: null,
          timestamp: new Date().toISOString(),
        });
      }

      await this.epgService.ensureLoaded();

      const channel = this.m3uService.getChannelById(channelId);
      if (!channel) {
        return res.status(404).json({
          success: false,
          message: 'Canal não encontrado',
          data: null,
          timestamp: new Date().toISOString(),
        });
      }

      const epgChannelId = this.epgService.getEpgChannelId(channelId);
      if (!epgChannelId) {
        return res.status(404).json({
          success: false,
          message: 'Canal sem programação no guia (sem match EPG)',
          data: null,
          timestamp: new Date().toISOString(),
        });
      }

      const programmes = (this.epgService.getGuide(channelId) || []).map(toPublicProgramme);

      return res.status(200).json({
        success: true,
        message: 'Grade de programação carregada com sucesso',
        data: {
          channelId,
          epgChannelId,
          channel: toPublicChannel(channel),
          total: programmes.length,
          programmes,
        },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error('Erro ao buscar grade de programação:', error);
      return res.status(500).json({
        success: false,
        message: 'Erro interno do servidor',
        data: null,
        timestamp: new Date().toISOString(),
      });
    }
  };

  /**
   * GET /api/epg/grid
   * Grade completa para o grid do guia de TV: todos os canais casados com EPG
   * e a programação recortada à janela [from, to] (epoch ms, opcionais — o
   * servidor usa "agora − 2h → +25h" por padrão). Validação Joi-style → 422
   * com `errors[]`. Nunca expõe a EPG_URL.
   */
  gridGuide = async (req, res) => {
    const now = Date.now();
    const rawFrom = req.query && req.query.from;
    const rawTo = req.query && req.query.to;
    const bothProvided = rawFrom !== undefined || rawTo !== undefined;

    let from;
    let to;
    const errors = [];
    if (bothProvided) {
      from = rawFrom !== undefined ? Number(rawFrom) : undefined;
      to = rawTo !== undefined ? Number(rawTo) : undefined;
      if (from === undefined || !Number.isFinite(from)) errors.push('"from" deve ser um timestamp em milissegundos (epoch)');
      if (to === undefined || !Number.isFinite(to)) errors.push('"to" deve ser um timestamp em milissegundos (epoch)');
      if (errors.length === 0 && from >= to) errors.push('"from" deve ser anterior a "to"');
      if (errors.length === 0 && to - from > MAX_GRID_SPAN_MS) errors.push(`janela máxima do grid é ${Math.round(MAX_GRID_SPAN_MS / (24 * HOUR_MS))} dias`);
    } else {
      // Padrão: 2h para trás (redondadas à hora) + 25h adiante.
      from = Math.floor(now / HOUR_MS) * HOUR_MS - 2 * HOUR_MS;
      to = from + 27 * HOUR_MS;
    }

    if (errors.length > 0) {
      return res.status(422).json({
        success: false,
        message: 'Parâmetros inválidos para o grid do guia',
        errors,
        data: null,
        timestamp: new Date().toISOString(),
      });
    }

    try {
      if (!this.epgService.isEnabled()) {
        return res.status(200).json({
          success: true,
          message: 'Guia de canais desativado (EPG_ENABLED=false)',
          data: { from, to, now, total: 0, channels: [] },
          timestamp: new Date().toISOString(),
        });
      }

      await this.epgService.ensureLoaded();

      const windowData = this.epgService.getGrid(from, to, now);
      const channels = [];
      for (const row of windowData.channels) {
        const channel = this.m3uService.getChannelById(row.channelId);
        if (!channel) continue; // sumiu da M3U — não deve aparecer
        channels.push({
          ...toPublicChannel(channel),
          epgChannelId: row.epgChannelId,
          displayName: row.displayName,
          programmes: row.programmes.map(toPublicProgramme),
        });
      }

      return res.status(200).json({
        success: true,
        message: 'Grid do guia carregado com sucesso',
        data: {
          from: new Date(from).toISOString(),
          to: new Date(to).toISOString(),
          now: new Date(now).toISOString(),
          total: channels.length,
          channels,
        },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error('Erro ao carregar grid do guia:', error);
      return res.status(500).json({
        success: false,
        message: 'Erro interno do servidor',
        data: null,
        timestamp: new Date().toISOString(),
      });
    }
  };
}

const HOUR_MS = 60 * 60 * 1000;
const MAX_GRID_SPAN_MS = 7 * 24 * HOUR_MS; // janela máxima: 7 dias

function clampLimit(raw, def, max) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.max(1, Math.min(max, Math.round(n)));
}

/**
 * Programa em formato público (ISO strings; nunca contém URL/segredo).
 */
function toPublicProgramme(p) {
  if (!p) return null;
  return {
    title: p.title,
    subtitle: p.subtitle || '',
    description: p.description || '',
    categories: p.categories || [],
    start: new Date(p.start).toISOString(),
    stop: new Date(p.stop).toISOString(),
    isLive: Boolean(p.isLive),
  };
}

module.exports = EPGController;