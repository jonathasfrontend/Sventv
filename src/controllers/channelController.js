const M3UService = require('../services/m3uService');
const ChannelHealthService = require('../services/channelHealthService');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

/**
 * Controller responsável pelas operações relacionadas aos canais de TV
 */
class ChannelController {
  constructor() {
    this.m3uService = new M3UService();
    
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
      const channels = this.m3uService.getAllChannels();

      res.status(200).json({
        success: true,
        message: 'Canais carregados com sucesso',
        data: {
          total: channels.length,
          channels: channels
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
        data: channel,
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
      const playerHtml = this.generatePlayerHTML(channel, req.apiToken || req.query.token || '');

      res.setHeader('Content-Type', 'text/html');
      res.setHeader('X-Frame-Options', 'ALLOWALL');
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
          channels: channels
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
          channels: channels
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
    // Se o template não foi carregado, usa fallback simples
    // if (!this.playerTemplate) {
    //   return this.generateFallbackPlayerHTML(channel);
    // }

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
   * @param {string} text - Conteúdo da playlist
   * @param {string} baseUrl - URL absoluta da playlist original
   * @param {string} channelId - ID do canal
   * @param {string} token - API token do usuário
   * @returns {string} - Playlist reescrita
   */
  _rewritePlaylist(text, baseUrl, channelId, token) {
    const proxyBase = `/api/channels/${encodeURIComponent(channelId)}/proxy`;

    const wrap = (raw) => {
      if (!raw) return raw;
      try {
        const abs = new URL(raw.trim(), baseUrl).toString();
        return `${proxyBase}?token=${encodeURIComponent(token)}&u=${encodeURIComponent(abs)}`;
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
   * @route GET /api/channels/:id/proxy?token=<apiToken> [&u=<urlAbsoluta>]
   */
  streamProxy = async (req, res) => {
    try {
      const { id } = req.params;
      const token = req.apiToken || req.query.token || '';
      const channel = this.m3uService.getChannelById(id);

      if (!channel) {
        return res.status(404).json({
          success: false,
          message: 'Canal não encontrado'
        });
      }

      // Alvo: canal principal (?u ausente) ou sub-recurso da playlist (?u=...)
      const rawTarget = req.query.u ? String(req.query.u) : channel.url;

      let targetUrl;
      try {
        targetUrl = new URL(rawTarget);
      } catch {
        return res.status(400).json({ success: false, message: 'URL de stream inválida' });
      }

      if (!['http:', 'https:'].includes(targetUrl.protocol)) {
        return res.status(400).json({ success: false, message: 'Protocolo de stream não suportado' });
      }

      const upstream = await axios.get(targetUrl.toString(), {
        responseType: 'stream',
        timeout: 20000,
        maxRedirects: 5,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; SvenTV/2.0)',
          ...(req.headers.range ? { Range: req.headers.range } : {}),
        },
        validateStatus: () => true,
      });

      if (upstream.status >= 400) {
        return res.status(502).json({
          success: false,
          message: 'Fonte do stream indisponível'
        });
      }

      const contentType = (upstream.headers['content-type'] || '').toLowerCase();

      // Playlist → reescreve URIs para voltarem pelo proxy
      if (this._isPlaylistUrl(targetUrl.toString()) || contentType.includes('mpegurl')) {
        const chunks = [];
        for await (const chunk of upstream.data) chunks.push(chunk);
        const text = Buffer.concat(chunks).toString('utf-8');
        const rewritten = this._rewritePlaylist(text, targetUrl.toString(), id, token);

        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Frame-Options', 'ALLOWALL');
        res.setHeader('Access-Control-Allow-Origin', '*');
        return res.status(200).send(rewritten);
      }

      // Segmentos binários (.ts/.m4s/.mp4), chaves AES, etc. → pipe direto
      res.status(upstream.status);
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (upstream.headers['content-type']) res.setHeader('Content-Type', upstream.headers['content-type']);
      if (upstream.headers['content-length']) res.setHeader('Content-Length', upstream.headers['content-length']);
      if (upstream.headers['accept-ranges']) res.setHeader('Accept-Ranges', upstream.headers['accept-ranges']);
      if (upstream.headers['content-range']) res.setHeader('Content-Range', upstream.headers['content-range']);

      upstream.data.pipe(res);
    } catch (error) {
      console.error('Erro no proxy de stream:', error.message);
      if (!res.headersSent) {
        res.status(502).json({
          success: false,
          message: 'Erro ao encaminhar o stream'
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

  /**
   * Gera player simples como fallback (player antigo)
   * @param {Object} channel - Dados do canal
   * @returns {string} - HTML do player
   */
  generateFallbackPlayerHTML(channel) {
    return `
      <!DOCTYPE html>
      <html lang="pt-BR">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>${channel.name} - SvenTV</title>
          <style>
              * {
                  margin: 0;
                  padding: 0;
                  box-sizing: border-box;
              }
              
              body {
                  background: #000;
                  font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                  overflow: hidden;
              }
              
              .player-container {
                  position: relative;
                  width: 100vw;
                  height: 100vh;
                  background: #000;
              }
              
              .video-player {
                  width: 100%;
                  height: 100%;
                  object-fit: contain;
              }
              
              .channel-info {
                  position: absolute;
                  top: 10px;
                  left: 10px;
                  background: rgba(0, 0, 0, 0.7);
                  color: white;
                  padding: 8px 12px;
                  border-radius: 4px;
                  font-size: 14px;
                  z-index: 100;
                  opacity: 1;
                  transition: opacity 0.3s ease;
              }
              
              .channel-info.hidden {
                  opacity: 0;
              }
              
              .loading {
                  position: absolute;
                  top: 50%;
                  left: 50%;
                  transform: translate(-50%, -50%);
                  color: white;
                  font-size: 18px;
                  z-index: 200;
              }
              
              .error-message {
                  position: absolute;
                  top: 50%;
                  left: 50%;
                  transform: translate(-50%, -50%);
                  color: #ff4444;
                  text-align: center;
                  z-index: 300;
              }
              
              @keyframes spin {
                  0% { transform: rotate(0deg); }
                  100% { transform: rotate(360deg); }
              }
              
              .spinner {
                  width: 40px;
                  height: 40px;
                  border: 4px solid #333;
                  border-top: 4px solid #fff;
                  border-radius: 50%;
                  animation: spin 1s linear infinite;
                  margin: 0 auto 10px;
              }
          </style>
          <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
        </head>
        <body>
            <div class="player-container">
                <div class="loading" id="loading">
                    <div class="spinner"></div>
                    Carregando ${channel.name}...
                </div>
                
                <div class="channel-info" id="channelInfo">
                    <strong>${channel.name}</strong><br>
                </div>
                
                <video 
                    class="video-player" 
                    id="videoPlayer" 
                    controls 
                    autoplay 
                    muted
                    playsinline
                    poster="${channel.logo || ''}"
                ></video>
                
                <div class="error-message" id="errorMessage" style="display: none;">
                    <h3>Erro ao carregar o canal</h3>
                    <p>Verifique sua conexão com a internet</p>
                    <button onclick="location.reload()" style="margin-top: 10px; padding: 8px 16px; background: #007bff; color: white; border: none; border-radius: 4px; cursor: pointer;">
                        Tentar Novamente
                    </button>
                </div>
            </div>

            <script>
                const video = document.getElementById('videoPlayer');
                const loading = document.getElementById('loading');
                const errorMessage = document.getElementById('errorMessage');
                const channelInfo = document.getElementById('channelInfo');
                const streamUrl = '${channel.url}';
                
                // Auto-hide channel info after 5 seconds
                setTimeout(() => {
                    channelInfo.classList.add('hidden');
                }, 5000);
                
                // Show channel info on hover/touch
                document.addEventListener('mousemove', () => {
                    channelInfo.classList.remove('hidden');
                    clearTimeout(window.hideInfoTimer);
                    window.hideInfoTimer = setTimeout(() => {
                        channelInfo.classList.add('hidden');
                    }, 3000);
                });
                
                function initializePlayer() {
                    // Detecta o tipo de stream pela URL
                    const isHLS = streamUrl.includes('.m3u8') || streamUrl.includes('playlist');
                    const isTS = streamUrl.includes('.ts');
                    
                    if (isHLS && Hls.isSupported()) {
                        // Stream HLS com HLS.js
                        const hls = new Hls({
                            enableWorker: true,
                            lowLatencyMode: true,
                            backBufferLength: 90,
                            maxBufferLength: 120,
                            maxMaxBufferLength: 180,
                            startLevel: -1,
                            capLevelToPlayerSize: true
                        });
                        
                        hls.loadSource(streamUrl);
                        hls.attachMedia(video);
                        
                        hls.on(Hls.Events.MANIFEST_PARSED, () => {
                            loading.style.display = 'none';
                            video.play().catch(e => console.log('Autoplay prevented:', e));
                        });
                        
                        hls.on(Hls.Events.ERROR, (event, data) => {
                            console.error('HLS Error:', data);
                            if (data.fatal) {
                                switch (data.type) {
                                    case Hls.ErrorTypes.NETWORK_ERROR:
                                        console.log('Network error - tentando recuperar...');
                                        hls.startLoad();
                                        break;
                                    case Hls.ErrorTypes.MEDIA_ERROR:
                                        console.log('Media error - tentando recuperar...');
                                        hls.recoverMediaError();
                                        break;
                                    default:
                                        showError();
                                        break;
                                }
                            }
                        });
                        
                    } else if (isHLS && video.canPlayType('application/vnd.apple.mpegurl')) {
                        // Safari native HLS support
                        video.src = streamUrl;
                        video.addEventListener('loadedmetadata', () => {
                            loading.style.display = 'none';
                        });
                        video.addEventListener('error', showError);
                        
                    } else {
                        // Direct stream (TS files, MP4, etc.)
                        video.src = streamUrl;
                        
                        // Para streams TS, configura headers apropriados
                        if (isTS) {
                            video.crossOrigin = 'anonymous';
                        }
                        
                        video.addEventListener('loadedmetadata', () => {
                            loading.style.display = 'none';
                        });
                        
                        video.addEventListener('canplay', () => {
                            loading.style.display = 'none';
                        });
                        
                        video.addEventListener('error', (e) => {
                            console.error('Video Error:', e);
                            showError();
                        });
                        
                        // Tenta carregar o vídeo
                        video.load();
                    }
                }
                
                function showError() {
                    loading.style.display = 'none';
                    errorMessage.style.display = 'block';
                }
                
                // Initialize player when page loads
                window.addEventListener('load', initializePlayer);
                
                // Handle video events
                video.addEventListener('waiting', () => {
                    loading.style.display = 'block';
                });
                
                video.addEventListener('playing', () => {
                    loading.style.display = 'none';
                    errorMessage.style.display = 'none';
                });
            </script>
        </body>
      </html>`;
  }
}

module.exports = ChannelController;
