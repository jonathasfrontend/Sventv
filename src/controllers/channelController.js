const M3UService = require('../services/m3uService');
const EPGService = require('../services/epgService');
const ChannelHealthService = require('../services/channelHealthService');
const ChannelStateService = require('../services/channelStateService');
const { issuePlaybackToken, openSealedTarget, sealTarget } = require('../services/streamTokenService');
const { assertSafeTarget } = require('../services/ssrfGuard');
const { audit } = require('../services/auditService');
const { inc, snapActiveStream, recordProxyLatency } = require('../utils/metrics');
const { acquireSlot, releaseSlot } = require('../middlewares/streamLimiter');
const { toPublicChannel, toPublicChannels } = require('../utils/publicChannel');
const { safeScriptJson } = require('../utils/safeScriptJson');
const config = require('../config/app');
const axios = require('axios');
const http = require('http');
const https = require('https');
const net = require('net');
const dns = require('dns');
const fs = require('fs');
const path = require('path');

/**
 * Controller responsável pelas operações relacionadas aos canais de TV
 */
class ChannelController {
  constructor() {
    // Instância única compartilhada (1 download por lambda)
    this.m3uService = M3UService.getShared();
    this.epgService = EPGService.getShared();

    // Agentes do proxy: quando o host já é um IP literal, pula a
    // resolução DNS — resolvers em ambientes serverless podem falhar
    // com ENOTFOUND mesmo para IPs puros.
    const smartLookup = (hostname, options, callback) => {
      const family = net.isIP(hostname);
      if (family) {
        return process.nextTick(() => callback(null, hostname, family));
      }
      return dns.lookup(hostname, options, callback);
    };
    this._proxyHttpAgent = new http.Agent({ keepAlive: true, maxSockets: 100, lookup: smartLookup });
    this._proxyHttpsAgent = new https.Agent({ keepAlive: true, maxSockets: 100, lookup: smartLookup });
    
    // Carregar template HTML uma única vez
    try {
      this.playerTemplate = fs.readFileSync(
        path.join(__dirname, '../Player/index.html'),
        'utf-8'
      );
    } catch (error) {
      console.error('Erro ao carregar template do player:', error);
      this.playerTemplate = null;
    }

    // Serviço de verificação de saúde dos canais
    try {
      this.channelHealthService = new ChannelHealthService(this.m3uService, {
        intervalMs: config.health.checkIntervalMs,
        requestTimeout: config.health.requestTimeoutMs,
        failoverThreshold: config.health.failoverThreshold,
        failbackMinMs: config.health.failbackMinMs,
      });
    } catch (e) {
      this.channelHealthService = null;
      console.error('Erro ao inicializar ChannelHealthService:', e && e.message);
    }

    // Estado administrativo (live/maintenance/blocked) — singleton em memória
    this.channelStateService = ChannelStateService.getShared();
  }

  /**
   * Lista todos os canais disponíveis
   * @param {Object} req - Request object
   * @param {Object} res - Response object
   */
  getAllChannels = (req, res) => {
    try {
      const all = this.m3uService.getAllChannels();

      // Paginação opcional (?page=&limit=). Sem parâmetros devolve a
      // lista completa — comportamento retrocompatível com clientes atuais.
      let channels = all;
      let pagination;
      if (req.query.page !== undefined || req.query.limit !== undefined) {
        const limitRaw = parseInt(req.query.limit, 10);
        const pageRaw = parseInt(req.query.page, 10);
        const limit = Math.min(Math.max(Number.isNaN(limitRaw) ? 50 : limitRaw, 1), 500);
        const page = Math.max(Number.isNaN(pageRaw) ? 1 : pageRaw, 1);
        const start = (page - 1) * limit;
        channels = all.slice(start, start + limit);
        pagination = {
          page,
          limit,
          total: all.length,
          totalPages: Math.max(Math.ceil(all.length / limit), 1),
        };
      }

      res.status(200).json({
        success: true,
        message: 'Canais carregados com sucesso',
        data: {
          total: channels.length,
          ...(pagination ? { pagination } : {}),
          channels: toPublicChannels(channels)
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('Erro ao buscar canais:', error);
      res.status(500).json({
        success: false,
        message: 'Erro interno do servidor',
        error: error.message
      });
    }
  };

  /**
   * Busca um canal específico pelo ID
   * @param {Object} req - Request object
   * @param {Object} res - Response object
   */
  getChannelById = (req, res) => {
    try {
      const { id } = req.params;
      const channel = this.m3uService.getChannelById(id);

      if (!channel) {
        return res.status(404).json({
          success: false,
          message: 'Canal não encontrado',
          data: null
        });
      }

      res.status(200).json({
        success: true,
        message: 'Canal encontrado',
        data: toPublicChannel(channel),
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('Erro ao buscar canal:', error);
      res.status(500).json({
        success: false,
        message: 'Erro interno do servidor',
        error: error.message
      });
    }
  };

  /**
   * Retorna o stream de vídeo do canal para uso em iframe
   * @param {Object} req - Request object
   * @param {Object} res - Response object
   */
  getChannelStream = async (req, res) => {
    try {
      const { id } = req.params;
      const channel = this.m3uService.getChannelById(id);

      if (!channel) {
        return res.status(404).json({
          success: false,
          message: 'Canal não encontrado'
        });
      }

      // Retorna HTML com player para iframe
      const playerHtml = await this.generatePlayerHTML(channel, req.authToken || req.apiToken || req.query.token || '');

      res.setHeader('Content-Type', 'text/html');
      res.setHeader('Content-Security-Policy', "frame-ancestors *");
      res.setHeader('Access-Control-Allow-Origin', '*');

      res.status(200).send(playerHtml);
    } catch (error) {
      console.error('Erro ao gerar stream:', error);
      res.status(500).json({
        success: false,
        message: 'Erro interno do servidor',
        error: error.message
      });
    }
  };

  /**
   * Emite um playback token de curta duração vinculado a um único canal.
   *
   * O cliente autentica com o API token permanente, recebe um JWT curto
   * (default 2h) válido apenas para este canal e usa esse token no player
   * (iframe /stream e proxy). O API token permanente nunca precisa chegar
   * ao navegador do player.
   *
   * @route POST /api/channels/:id/playback
   */
  requestPlayback = async (req, res) => {
    try {
      const { id } = req.params;
      const channel = this.m3uService.getChannelById(id);

      if (!channel) {
        return res.status(404).json({
          success: false,
          message: 'Canal não encontrado'
        });
      }

      // Gating de estado administrativo ANTES de emitir token/upstream.
      const state = this.channelStateService ? await this.channelStateService.get(id) : 'live';
      if (state !== 'live') {
        inc('streamBlocked');
        audit({
          action: 'stream.playback_blocked',
          req,
          userId: req.user?.id,
          channelId: id,
          meta: { state },
        });
        const blocked = state === 'blocked';
        return res.status(blocked ? 403 : 503).json({
          success: false,
          message: blocked
            ? 'Canal bloqueado.'
            : 'Canal em manutenção. Tente novamente mais tarde.',
          data: { channelId: id, state },
          timestamp: new Date().toISOString()
        });
      }

      const { playbackToken, expiresIn } = issuePlaybackToken(req.user, id);

      audit({
        action: 'stream.playback_token',
        req,
        userId: req.user?.id,
        channelId: id,
      });

      // Registra um "stream ativo" enquanto o playback token for válido:
      // incrementa agora e agenda o decremento após o período de expiração.
      // Aproxima o número de players abertos/ativos desta instância.
      snapActiveStream(1);
      if (expiresIn > 0) {
        setTimeout(() => snapActiveStream(-1), expiresIn * 1000).unref?.();
      }

      res.status(200).json({
        success: true,
        message: 'Playback token emitido com sucesso',
        data: {
          playbackToken,
          channelId: id,
          expiresIn
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('Erro ao emitir playback token:', error);
      res.status(500).json({
        success: false,
        message: 'Erro interno do servidor',
        error: error.message
      });
    }
  };

  /**
   * Busca canais por categoria
   * @param {Object} req - Request object
   * @param {Object} res - Response object
   */
  getChannelsByCategory = (req, res) => {
    try {
      const { category } = req.params;
      const channels = this.m3uService.getChannelsByCategory(category);

      res.status(200).json({
        success: true,
        message: `Canais da categoria "${category}" encontrados`,
        data: {
          category: category,
          total: channels.length,
          channels: toPublicChannels(channels)
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('Erro ao buscar canais por categoria:', error);
      res.status(500).json({
        success: false,
        message: 'Erro interno do servidor',
        error: error.message
      });
    }
  };

  /**
   * Busca canais por termo de pesquisa
   * @param {Object} req - Request object
   * @param {Object} res - Response object
   */
  searchChannels = (req, res) => {
    try {
      const { q } = req.query;

      if (!q) {
        return res.status(400).json({
          success: false,
          message: 'Parâmetro de busca "q" é obrigatório'
        });
      }

      const channels = this.m3uService.searchChannels(q);

      res.status(200).json({
        success: true,
        message: `Resultados da busca por "${q}"`,
        data: {
          searchTerm: q,
          total: channels.length,
          channels: toPublicChannels(channels)
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('Erro ao buscar canais:', error);
      res.status(500).json({
        success: false,
        message: 'Erro interno do servidor',
        error: error.message
      });
    }
  };

  /**
   * Retorna estatísticas dos canais
   * @param {Object} req - Request object
   * @param {Object} res - Response object
   */
  getStats = (req, res) => {
    try {
      const stats = this.m3uService.getStats();

      res.status(200).json({
        success: true,
        message: 'Estatísticas carregadas com sucesso',
        data: stats,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('Erro ao obter estatísticas:', error);
      res.status(500).json({
        success: false,
        message: 'Erro interno do servidor',
        error: error.message
      });
    }
  };

  /**
   * Lista todas as categorias disponíveis
   * @param {Object} req - Request object
   * @param {Object} res - Response object
   */
  getCategories = (req, res) => {
    try {
      const categories = this.m3uService.getCategories();

      res.status(200).json({
        success: true,
        message: 'Categorias carregadas com sucesso',
        data: {
          total: categories.length,
          categories: categories
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('Erro ao buscar categorias:', error);
      res.status(500).json({
        success: false,
        message: 'Erro interno do servidor',
        error: error.message
      });
    }
  };

  /**
   * Recarrega a lista de canais do arquivo M3U
   * @param {Object} req - Request object
   * @param {Object} res - Response object
   */
  reloadChannels = async (req, res) => {
    try {
      await this.m3uService.reloadChannels();
      // Recalcula o matching EPG↔M3U após a lista ser substituída.
      this.epgService.rebuildMatching();

      res.status(200).json({
        success: true,
        message: 'Canais recarregados com sucesso',
        data: {
          total: this.m3uService.getAllChannels().length
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('Erro ao recarregar canais:', error);
      res.status(500).json({
        success: false,
        message: 'Erro interno do servidor',
        error: error.message
      });
    }
  };

  /**
   * Retorna os status verificados dos canais (admin)
   */
  getStatuses = (req, res) => {
    try {
      if (!this.channelHealthService) {
        return res.status(500).json({ success: false, message: 'Health service indisponível' });
      }

      const statuses = this.channelHealthService.getStatuses();
      res.status(200).json({ success: true, data: statuses, timestamp: new Date().toISOString() });
    } catch (error) {
      console.error('Erro ao obter statuses:', error);
      res.status(500).json({ success: false, message: 'Erro interno do servidor', error: error.message });
    }
  };

  /**
   * Força checagem imediata de um canal
   */
  checkChannel = async (req, res) => {
    try {
      if (!this.channelHealthService) return res.status(500).json({ success: false, message: 'Health service indisponível' });
      const { id } = req.params;
      const result = await this.channelHealthService.checkChannelById(id);
      res.status(200).json({ success: true, data: { id, ok: Boolean(result.ok), checkedAt: result.checkedAt }, timestamp: new Date().toISOString() });
    } catch (error) {
      console.error('Erro ao checar canal:', error);
      res.status(500).json({ success: false, message: 'Erro interno do servidor', error: error.message });
    }
  };

  /**
   * Generates string HTML do player para uso em iframe
   * @param {Object} channel - Dados do canal
   * @param {string} token - Token de autenticação
   * @returns {Promise<string>} - HTML do player
   */
  async generatePlayerHTML(channel, token = '') {
    // O player consome o stream via proxy HTTPS da própria API,
    // evitando Mixed Content quando a origem é apenas HTTP.
    const proxyUrl = `/api/channels/${encodeURIComponent(channel.id)}/proxy?token=${encodeURIComponent(token)}`;
    const state = this.channelStateService ? await this.channelStateService.get(channel.id) : 'live';

    // EPG do player — fornecido AQUI (server-side), nunca buscado pelo
    // navegador durante a reprodução. Janela "agora − 1h → agora + 12h".
    // Fail-open: falha/desativado/sem match → [] (player continua normal).
    // Não bloqueia a geração: lê o cache atual imediatamente e aquece o
    // refresh (se necessário) em background para os próximos players.
    const epg = await this.getPlayerEpg(channel.id);

    // Substitui placeholders no template. CHANNEL_ID/CHANNEL_CATEGORY
    // alimentam o módulo de analytics do player; os dados vão dentro de um
    // objeto JS — escapeHtml cobre '"'\'.
    // CHANNEL_STATE permite o player exibir overlay de manutenção/bloqueio
    // em vez de tentar reproduzir indefinidamente.
    // CHANNEL_EPG_JSON é um literal JSON de TEXTO externo (XMLTV) inserido
    // dentro do <script> — serialização segura (safeScriptJson) neutraliza
    // `</script>`/`<!--`/U+2028 antes de entrar no HTML.
    return this.playerTemplate
      .replace(/\{\{CHANNEL_ID\}\}/g, this.escapeHtml(channel.id))
      .replace(/\{\{CHANNEL_NAME\}\}/g, this.escapeHtml(channel.name))
      .replace(/\{\{CHANNEL_URL\}\}/g, this.escapeHtml(proxyUrl))
      .replace(/\{\{CHANNEL_LOGO\}\}/g, this.escapeHtml(channel.logo || ''))
      .replace(/\{\{CHANNEL_CATEGORY\}\}/g, this.escapeHtml(channel.category || ''))
      .replace(/\{\{CHANNEL_FORMAT\}\}/g, this.escapeHtml(channel.format || ''))
      .replace(/\{\{CHANNEL_STATE\}\}/g, this.escapeHtml(state))
      .replace(/\{\{CHANNEL_EPG_JSON\}\}/g, safeScriptJson(epg));
  }

  /**
   * Janela de EPG para o player (agora − 1h → agora + 12h).
   *
   * Nunca lança: qualquer falha (serviço desativado, sem match, cache
   * vazio, erro inesperado) devolve [] — o EPG é complementar ao stream.
   * A chamada de aquecimento (ensureLoaded) é fire-and-forget para não
   * atrasar a geração do HTML do player num cold start com EPG sem cache.
   */
  async getPlayerEpg(channelId) {
    try {
      const svc = this.epgService;
      if (!svc || !svc.isEnabled || !svc.isEnabled()) return [];
      const now = Date.now();
      const from = now - PLAYER_EPG_PAST_MS; // 1h para trás
      const to = now + PLAYER_EPG_FUTURE_MS; // 12h adiante

      // Aquece o cache sem bloquear (nunca rejeita internamente).
      const warm = svc.ensureLoaded ? svc.ensureLoaded() : null;
      if (warm && typeof warm.then === 'function') warm.catch(() => {});

      const programmes = svc.getPlayerWindow ? svc.getPlayerWindow(channelId, from, to) : [];
      return Array.isArray(programmes) ? programmes : [];
    } catch (_) {
      return [];
    }
  }

  /**
   * Verifica se a URL aponta para uma playlist HLS (.m3u8)
   * @param {string} url - URL do recurso
   * @returns {boolean}
   */
  _isPlaylistUrl(url) {
    try {
      return new URL(url).pathname.toLowerCase().includes('.m3u8');
    } catch {
      return false;
    }
  }

  /**
   * Reescreve uma playlist HLS para que todos os recursos
   * (segmentos, variantes e chaves) passem pelo proxy da API.
   *
   * Cada sub-recurso é referenciado por um parâmetro opaco `?p=` (blob
   * AES-256-GCM contendo canal + URL upstream). O navegador jamais vê a
   * URL real da origem — eliminando o vazamento de IPs no M3U8 entregue
   * ao cliente.
   *
   * @param {string} text - Conteúdo da playlist
   * @param {string} baseUrl - URL absoluta da playlist original
   * @param {string} channelId - ID do canal
   * @param {string} token - Token de autenticação efetivo (API ou playback)
   * @returns {string} - Playlist reescrita
   */
  _rewritePlaylist(text, baseUrl, channelId, token) {
    const proxyBase = `/api/channels/${encodeURIComponent(channelId)}/proxy`;

    const wrap = (raw) => {
      if (!raw) return raw;
      try {
        const abs = new URL(raw.trim(), baseUrl).toString();
        const sealed = sealTarget(abs, channelId);
        return `${proxyBase}?token=${encodeURIComponent(token)}&p=${sealed}`;
      } catch {
        return raw;
      }
    };

    return text
      .split('\n')
      .map((line) => {
        const t = line.trim();
        if (!t) return line;
        if (t.startsWith('#')) {
          // Reescreve atributos URI="..." (EXT-X-KEY, EXT-X-MAP, EXT-X-MEDIA, etc.)
          return line.replace(/URI="([^"]+)"/g, (_m, uri) => `URI="${wrap(uri)}"`);
        }
        return wrap(line);
      })
      .join('\n');
  }

  /**
   * Proxy de stream: encaminha playlists HLS e segmentos para o
   * cliente através da origem HTTPS da API, resolvendo erros de
   * Mixed Content com fontes HTTP.
   *
   * O alvo é sempre resolvido server-side: ou é a URL do canal
   * (requisição inicial), ou um blob selado `?p=` emitido pelo próprio
   * proxy (sub-recursos). O parâmetro legado `?u=<url>` foi removido —
   * ele permitia SSRF e vazava a origem real.
   *
   * @route GET /api/channels/:id/proxy?token=<token> [&p=<blobSelado>]
   */
  streamProxy = async (req, res) => {
    try {
      const { id } = req.params;
      const token = req.authToken || req.apiToken || req.query.token || '';
      inc('proxyRequests');
      const channel = this.m3uService.getChannelById(id);

      if (!channel) {
        return res.status(404).json({
          success: false,
          message: 'Canal não encontrado'
        });
      }

      // Gating de estado administrativo: bloqueia ANTES de consumir slot,
      // iniciar saúde ou acessar o upstream.
      const channelState = this.channelStateService ? await this.channelStateService.get(id) : 'live';
      if (channelState !== 'live') {
        inc('streamBlocked');
        const blocked = channelState === 'blocked';
        return res.status(blocked ? 403 : 503).json({
          success: false,
          message: blocked
            ? 'Canal bloqueado.'
            : 'Canal em manutenção. Tente novamente mais tarde.',
          data: { channelId: id, state: channelState },
        });
      }

      const isInitialRequest = !req.query.p;

      // Limite de streams simultâneos por usuário (apenas na requisição
      // inicial do player; segmentos têm rate limiter próprio e alto).
      if (isInitialRequest && !(await acquireSlot(req))) {
        inc('streamRequests');
        return res.status(429).json({
          success: false,
          message: 'Limite de streams simultâneos atingido para esta conta.',
        });
      }

      if (isInitialRequest) {
        // Incrementa no início do stream (bootstrap da requisição inicial)
        // e decrementa ao finalizar. O decremento em 'finish' + liberação
        // em 'close' são idempotentes (clamp em 0).
        snapActiveStream(1);
        res.once('finish', () => snapActiveStream(-1));
        res.once('close', () => releaseSlot(req));
      }

      // Alvo: canal principal (sem ?p) ou sub-recurso selado (?p=...)
      let rawTarget;
      // Fontes candidatas (só na requisição inicial): [ativa, alternativa].
      let sourceCandidates = null;

      // Parâmetro legado ?u=<url> foi removido por segurança: rejeita
      // explicitamente para deixar o contrato claro (era vetor de SSRF).
      if (req.query.u) {
        return res.status(400).json({
          success: false,
          message: 'Parâmetro "u" não é mais suportado. Sub-recursos usam blobs selados emitidos pelo próprio proxy.'
        });
      }

      if (req.query.p) {
        const opened = openSealedTarget(String(req.query.p));

        if (!opened || opened.channelId !== id) {
          return res.status(403).json({
            success: false,
            message: 'Sub-recurso de stream inválido para este canal'
          });
        }

        rawTarget = opened.url;
      } else {
        // Failover automático: a fonte ativa vem primeiro e a alternativa em
        // seguida. Sub-recursos (?p=...) NÃO fazem failover — o blob está
        // amarrado à URL exata que os originou.
        if (this.channelHealthService) {
          sourceCandidates = this.channelHealthService.resolveSourceUrls(channel);
        }
        rawTarget = (sourceCandidates && sourceCandidates[0]) || channel.url;
      }

      let targetUrl;
      try {
        targetUrl = new URL(rawTarget);
      } catch {
        return res.status(400).json({ success: false, message: 'URL de stream inválida' });
      }

      if (!['http:', 'https:'].includes(targetUrl.protocol)) {
        return res.status(400).json({ success: false, message: 'Protocolo de stream não suportado' });
      }

      // Guarda anti-SSRF: bloqueia destinos link-local/privado/loopback
      // (169.254.169.254, 127.0.0.1, 10/8, etc.) antes de qualquer saída.
      try {
        await assertSafeTarget(targetUrl);
      } catch (ssrfErr) {
        if (ssrfErr.code === 'SSRF_BLOCKED') {
          inc('proxySSRFBlocked');
          inc('proxyErrors');
          return res.status(403).json({ success: false, message: 'Destino de stream bloqueado' });
        }
        // Erro de DNS ou URL inválida → 502 genérico, sem expor o destino.
        inc('proxyErrors');
        return res.status(502).json({ success: false, message: 'Erro ao encaminhar o stream' });
      }

      let upstream = null;
      let netError = null;

      // Busca na origem com suporte manual a redirects: cada hop é
      // revalidado pela guarda anti-SSRF antes de ser seguido.
      const fetchWithRedirects = async (url, rangeHeader, hopsLeft) => {
        try {
          await assertSafeTarget(url);
        } catch (ssrfErr) {
          if (ssrfErr.code === 'SSRF_BLOCKED') {
            const e = new Error('Destino de stream bloqueado');
            e.code = 'SSRF_BLOCKED';
            throw e;
          }
          throw ssrfErr;
        }

        const response = await axios.get(url.toString(), {
          responseType: 'stream',
          timeout: 15000,
          maxRedirects: 0,
          httpAgent: this._proxyHttpAgent,
          httpsAgent: this._proxyHttpsAgent,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
            'Accept': '*/*',
            ...(rangeHeader ? { Range: rangeHeader } : {}),
          },
          validateStatus: (status) => (status >= 300 && status < 400) || status < 300,
        });

        if (response.status >= 300 && response.status < 400) {
          // Libera o corpo do redirect (não consumido)
          if (response.data && typeof response.data.destroy === 'function') {
            response.data.destroy();
          }
          const location = response.headers.location;
          if (location && hopsLeft > 0) {
            const nextUrl = new URL(location, url);
            if (nextUrl.protocol !== 'http:' && nextUrl.protocol !== 'https:') {
              const e = new Error('Protocolo de stream não suportado');
              e.code = 'BAD_PROTOCOL';
              throw e;
            }
            return fetchWithRedirects(nextUrl, req.headers.range, hopsLeft - 1);
          }
          // Sem location ou limite de hops: devolve a resposta 3xx
          // (o upstream retornará o corpo vazio, tratado como 502 abaixo).
          const e = new Error('Redirecionamento não seguido');
          e.code = 'TOO_MANY_REDIRECTS';
          throw e;
        }

        return { response, targetUrl: url };
      };

      const fetchStart = Date.now();

      // Requisição inicial: tenta a fonte ativa e, se falhar por rede, a
      // alternativa (failover). Cada hop continua revalidado pela guarda SSRF.
      const candidates = (sourceCandidates && sourceCandidates.length)
        ? sourceCandidates
        : [targetUrl.toString()];
      let usedCandidateIndex = 0;
      let usedTargetUrl = targetUrl;

      for (let i = 0; i < candidates.length && !upstream; i++) {
        let candidateUrl;
        try {
          candidateUrl = new URL(candidates[i]);
        } catch {
          continue;
        }

        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const result = await fetchWithRedirects(candidateUrl, req.headers.range, 5);
            upstream = result.response;
            usedTargetUrl = result.targetUrl;
            usedCandidateIndex = i;
            netError = null;
            break;
          } catch (e) {
            netError = e;
            if (e.code === 'SSRF_BLOCKED') break;
            if (attempt === 0) {
              await new Promise((r) => setTimeout(r, 300));
            }
          }
        }

        // Segurança: SSRF bloqueado nunca tenta a fonte alternativa.
        if (netError && netError.code === 'SSRF_BLOCKED') break;
      }

      // Observabilidade do failover: usou uma fonte diferente da preferida.
      if (upstream && candidates.length > 1 && usedCandidateIndex > 0) {
        inc('proxyFailovers');
      }
      if (this.channelHealthService) {
        if (upstream) {
          this.channelHealthService.reportResult(id, candidates[usedCandidateIndex], true);
        } else if (candidates[0]) {
          this.channelHealthService.reportResult(id, candidates[0], false);
        }
      }

      // Mantém as mensagens/reescrita abaixo referenciando a URL efetiva.
      if (upstream) targetUrl = usedTargetUrl;
      recordProxyLatency(Date.now() - fetchStart);

      if (netError && netError.code === 'SSRF_BLOCKED') {
        inc('proxySSRFBlocked');
        inc('proxyErrors');
        return res.status(403).json({ success: false, message: 'Destino de stream bloqueado' });
      }

      if (!upstream) {
        inc('proxyErrors');
        console.error(`❌ Proxy [rede] ${targetUrl.host}: code=${netError?.code} msg=${netError?.message}`);
        return res.status(502).json({
          success: false,
          message: 'Erro ao encaminhar o stream',
          detail: netError?.code || 'NETWORK_ERROR'
        });
      }

      if (upstream.status >= 400) {
        inc('proxyErrors');
        console.error(`❌ Proxy [origem] ${targetUrl.host}: HTTP ${upstream.status}`);
        return res.status(502).json({
          success: false,
          message: 'Fonte do stream indisponível',
          detail: `HTTP ${upstream.status}`
        });
      }

      const contentType = (upstream.headers['content-type'] || '').toLowerCase();

      // Playlist → reescreve URIs para voltarem pelo proxy
      if (this._isPlaylistUrl(targetUrl.toString()) || contentType.includes('mpegurl')) {
        inc('proxyPlaylists');
        const chunks = [];
        for await (const chunk of upstream.data) chunks.push(chunk);
        const text = Buffer.concat(chunks).toString('utf-8');
        const rewritten = this._rewritePlaylist(text, targetUrl.toString(), id, token);

        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Security-Policy', "frame-ancestors *");
        res.setHeader('Access-Control-Allow-Origin', '*');
        return res.status(200).send(rewritten);
      }

      // Segmentos binários (.ts/.m4s/.mp4), chaves AES, etc. → pipe direto
      inc('proxySegments');
      res.status(upstream.status);
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (upstream.headers['content-type']) res.setHeader('Content-Type', upstream.headers['content-type']);
      if (upstream.headers['content-length']) res.setHeader('Content-Length', upstream.headers['content-length']);
      if (upstream.headers['accept-ranges']) res.setHeader('Accept-Ranges', upstream.headers['accept-ranges']);
      if (upstream.headers['content-range']) res.setHeader('Content-Range', upstream.headers['content-range']);

      upstream.data.pipe(res);
    } catch (error) {
      inc('proxyErrors');
      console.error(`❌ Proxy [exceção] code=${error.code} msg=${error.message}`);
      if (!res.headersSent) {
        res.status(502).json({
          success: false,
          message: 'Erro ao encaminhar o stream',
          detail: error.code || 'INTERNAL_ERROR'
        });
      } else {
        res.end();
      }
    }
  };

  /**
   * Escapa caracteres HTML para prevenir XSS
   * @param {string} text - Texto a ser escapado
   * @returns {string} - Texto escapado
   */
  escapeHtml(text) {
    if (typeof text !== 'string') return '';
    
    const map = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    };
    
    return text.replace(/[&<>"']/g, m => map[m]);
  }

}

const HOUR_MS = 60 * 60 * 1000;
// Janela de EPG embutida no player: 1h no passado (programa corrente se
// estendeu antes de agora) e 12h adiante (próximos programas suficientes
// para a UI "agora / próximo / progresso" sem payload excessivo).
const PLAYER_EPG_PAST_MS = HOUR_MS;
const PLAYER_EPG_FUTURE_MS = 12 * HOUR_MS;

module.exports = ChannelController;
