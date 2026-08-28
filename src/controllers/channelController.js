const M3UService = require('../services/m3uService');
const ChannelHealthService = require('../services/channelHealthService');
const { issuePlaybackToken, openSealedTarget, sealTarget } = require('../services/streamTokenService');
const { assertSafeTarget } = require('../services/ssrfGuard');
const { audit } = require('../services/auditService');
const { inc, snapActiveStream, recordProxyLatency } = require('../utils/metrics');
const { acquireSlot, releaseSlot } = require('../middlewares/streamLimiter');
const { toPublicChannel, toPublicChannels } = require('../utils/publicChannel');
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
      this.channelHealthService = new ChannelHealthService(this.m3uService);
    } catch (e) {
      this.channelHealthService = null;
      console.error('Erro ao inicializar ChannelHealthService:', e && e.message);
    }
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
  getChannelStream = (req, res) => {
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
      const playerHtml = this.generatePlayerHTML(channel, req.authToken || req.apiToken || req.query.token || '');

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
   * Gera HTML do player para uso em iframe
   * @param {Object} channel - Dados do canal
   * @returns {string} - HTML do player
   */
  generatePlayerHTML(channel, token = '') {
    // O player consome o stream via proxy HTTPS da própria API,
    // evitando Mixed Content quando a origem é apenas HTTP.
    const proxyUrl = `/api/channels/${encodeURIComponent(channel.id)}/proxy?token=${encodeURIComponent(token)}`;

    // Substitui placeholders no template
    return this.playerTemplate
      .replace(/\{\{CHANNEL_NAME\}\}/g, this.escapeHtml(channel.name))
      .replace(/\{\{CHANNEL_URL\}\}/g, this.escapeHtml(proxyUrl))
      .replace(/\{\{CHANNEL_LOGO\}\}/g, this.escapeHtml(channel.logo || ''))
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
        rawTarget = channel.url;
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
      const doFetch = () => fetchWithRedirects(targetUrl, req.headers.range, 5);

      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const result = await doFetch();
          upstream = result.response;
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

module.exports = ChannelController;
