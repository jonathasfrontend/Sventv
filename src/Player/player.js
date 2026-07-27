/**
 * SvenTV Advanced Player - Vanilla JavaScript
 * Converted from React/Next.js with full feature preservation
 * 
 * Features:
 * - HLS.js streaming with adaptive bitrate
 * - Custom Twitch-style controls
 * - Low latency mode
 * - Real-time statistics overlay
 * - localStorage persistence
 * - Keyboard shortcuts
 * - Click/Double-click handling
 * - Auto-hide controls
 * - Quality selection
 * - Picture-in-Picture
 * - Fullscreen support
 */

(function () {
  'use strict';

  // ==================== CACHE DE ELEMENTOS ====================
  const elements = {
    container: null,
    video: null,
    controls: null,
    playBtn: null,
    playIcon: null,
    volumeBtn: null,
    volumeIcon: null,
    volumeRange: null,
    volumeFill: null,
    settingsBtn: null,
    settingsMenu: null,
    pipBtn: null,
    fullscreenBtn: null,
    fullscreenIcon: null,
    qualityList: null,
    lowLatencyCheckbox: null,
    lowLatencyLabel: null,
    showStatsCheckbox: null,
    statsOverlay: null,
    liveBadge: null,
    loading: null,
    errorMessage: null,
    channelInfo: null,
    advancedSection: null
  };

  // ==================== ESTADO GLOBAL ====================
  const state = {
    hls: null,
    isPlaying: true,
    isMuted: false,
    volume: 1,
    currentLevel: -1,
    levels: [],
    streamType: 'native', // 'hls' ou 'native'
    lowLatencyMode: false,
    showStats: false,
    isFullscreen: false,
    showControls: true,
    hideTimeout: null,
    clickCount: 0,
    clickTimeout: null,
    rafId: null,
    lastStatsUpdate: 0,
    keyboardListenersAttached: false
  };

  // ==================== MÓDULO: STORAGE ====================
  const StorageModule = {
    get(key, defaultValue) {
      try {
        const value = localStorage.getItem(key);
        if (value === null) return defaultValue;

        // Tenta parsear como JSON, se falhar retorna string
        try {
          return JSON.parse(value);
        } catch {
          return value;
        }
      } catch (error) {
        console.warn('LocalStorage indisponível:', error);
        return defaultValue;
      }
    },

    set(key, value) {
      try {
        const stringValue = typeof value === 'string' ? value : JSON.stringify(value);
        localStorage.setItem(key, stringValue);
      } catch (error) {
        console.warn('Erro ao salvar no localStorage:', error);
      }
    },

    // Shortcuts
    getLowLatency() {
      return this.get('player_low_latency', false) === true || this.get('player_low_latency', false) === 'true';
    },

    getVolume() {
      const vol = parseFloat(this.get('player_volume', '1'));
      return isNaN(vol) ? 1 : Math.max(0, Math.min(1, vol));
    },

    getMuted() {
      return this.get('player_muted', false) === true || this.get('player_muted', false) === 'true';
    },

    getShowStats() {
      return this.get('player_show_stats', false) === true || this.get('player_show_stats', false) === 'true';
    },

    setLowLatency(value) {
      this.set('player_low_latency', value);
    },

    setVolume(value) {
      this.set('player_volume', value);
    },

    setMuted(value) {
      this.set('player_muted', value);
    },

    setShowStats(value) {
      this.set('player_show_stats', value);
    }
  };

  // ==================== MÓDULO: UI ====================
  const UIModule = {
    init() {
      // Cache de todos os elementos
      elements.container = document.getElementById('playerContainer');
      elements.video = document.getElementById('videoElement');
      elements.controls = document.getElementById('controls');
      elements.playBtn = document.getElementById('playBtn');
      elements.playIcon = document.getElementById('playIcon');
      elements.volumeBtn = document.getElementById('volumeBtn');
      elements.volumeIcon = document.getElementById('volumeIcon');
      elements.volumeRange = document.getElementById('volumeRange');
      elements.volumeFill = document.getElementById('volumeFill');
      elements.settingsBtn = document.getElementById('settingsBtn');
      elements.settingsMenu = document.getElementById('settingsMenu');
      elements.pipBtn = document.getElementById('pipBtn');
      elements.fullscreenBtn = document.getElementById('fullscreenBtn');
      elements.fullscreenIcon = document.getElementById('fullscreenIcon');
      elements.qualityList = document.getElementById('qualityList');
      elements.lowLatencyCheckbox = document.getElementById('lowLatencyCheckbox');
      elements.lowLatencyLabel = document.getElementById('lowLatencyLabel');
      elements.showStatsCheckbox = document.getElementById('showStatsCheckbox');
      elements.statsOverlay = document.getElementById('statsOverlay');
      elements.liveBadge = document.getElementById('liveBadge');
      elements.loading = document.getElementById('loading');
      elements.errorMessage = document.getElementById('errorMessage');
      elements.channelInfo = document.getElementById('channelInfo');
      elements.advancedSection = document.getElementById('advancedSection');
    },

    showUIElements() {
      if (elements.controls) {
        elements.controls.classList.remove('player__ui-element--hidden');
      }
      if (elements.channelInfo) {
        elements.channelInfo.classList.remove('player__ui-element--hidden');
      }
      if (elements.liveBadge) {
        elements.liveBadge.classList.remove('player__ui-element--hidden');
      }
      state.showControls = true;
    },

    hideUIElements() {
      // Só esconde se o vídeo não estiver pausado
      if (elements.video && !elements.video.paused) {
        if (elements.controls) {
          elements.controls.classList.add('player__ui-element--hidden');
        }
        if (elements.channelInfo) {
          elements.channelInfo.classList.add('player__ui-element--hidden');
        }
        if (elements.liveBadge) {
          elements.liveBadge.classList.add('player__ui-element--hidden');
        }
        state.showControls = false;
      }
    },

    updatePlayButton(isPlaying) {
      if (elements.playIcon) {
        elements.playIcon.src = isPlaying
          ? '/Player/assets/icons/pause.svg'
          : '/Player/assets/icons/play.svg';
      }
    },

    updateVolumeIcon(volume, muted) {
      if (!elements.volumeIcon) return;

      if (muted || volume === 0) {
        elements.volumeIcon.src = '/Player/assets/icons/speaker-x.svg';
      } else if (volume < 0.5) {
        elements.volumeIcon.src = '/Player/assets/icons/speaker-low.svg';
      } else {
        elements.volumeIcon.src = '/Player/assets/icons/speaker-high.svg';
      }
    },

    updateVolumeFill(volume) {
      if (elements.volumeFill) {
        elements.volumeFill.style.width = `${volume * 100}%`;
      }
    },

    updateFullscreenIcon(isFullscreen) {
      if (elements.fullscreenIcon) {
        elements.fullscreenIcon.src = isFullscreen
          ? '/Player/assets/icons/corners-in.svg'
          : '/Player/assets/icons/corners-out.svg';
      }
    },

    showLoading() {
      if (elements.loading) {
        elements.loading.style.display = 'block';
      }
    },

    hideLoading() {
      if (elements.loading) {
        elements.loading.style.display = 'none';
      }
    },

    showError() {
      if (elements.errorMessage) {
        elements.errorMessage.classList.add('player__error--visible');
      }
      this.hideLoading();
    },

    hideError() {
      if (elements.errorMessage) {
        elements.errorMessage.classList.remove('player__error--visible');
      }
    },

    showLiveBadge() {
      if (elements.liveBadge) {
        elements.liveBadge.style.display = 'block';
        // Remove a classe de esconder quando exibir pela primeira vez
        elements.liveBadge.classList.remove('player__ui-element--hidden');
      }
    },

    hideLiveBadge() {
      if (elements.liveBadge) {
        elements.liveBadge.style.display = 'none';
      }
    },

    toggleSettingsMenu() {
      if (elements.settingsMenu) {
        elements.settingsMenu.classList.toggle('player__settings-menu--open');
      }
    },

    closeSettingsMenu() {
      if (elements.settingsMenu) {
        elements.settingsMenu.classList.remove('player__settings-menu--open');
      }
    },

    showStats() {
      if (elements.statsOverlay) {
        elements.statsOverlay.classList.add('player__stats--visible');
      }
    },

    hideStats() {
      if (elements.statsOverlay) {
        elements.statsOverlay.classList.remove('player__stats--visible');
      }
    },

    updateErrorMessage(title, message) {
      if (elements.errorMessage) {
        const titleEl = elements.errorMessage.querySelector('.player__error-title');
        const messageEl = elements.errorMessage.querySelector('.player__error-message');
        
        if (titleEl) titleEl.textContent = title;
        if (messageEl) messageEl.textContent = message;
      }
    }
  };

  // ==================== MÓDULO: STALL MONITOR ====================
  const StallMonitor = {
    _interval: null,
    _stallCount: 0,
    _lastBufferEnd: 0,
    _lastCurrentTime: 0,

    start() {
      this.stop();
      this._stallCount = 0;
      this._interval = setInterval(() => this._check(), 1000);
    },

    stop() {
      if (this._interval) {
        clearInterval(this._interval);
        this._interval = null;
      }
      this._stallCount = 0;
    },

    _check() {
      const video = elements.video;
      if (!video || video.paused || video.ended) return;

      const currentTime = video.currentTime;
      const bufferLength = StatsModule.getBufferLength();
      const stalled = video.readyState < 3 && !video.paused;

      if (stalled) {
        this._stallCount++;
      } else {
        this._stallCount = 0;
      }

      if (bufferLength < 1 && !video.paused) {
        this._handleBufferLow(bufferLength);
      }

      if (this._stallCount >= 3 && state.hls) {
        this._handleStall();
      }

      this._lastCurrentTime = currentTime;
    },

    _handleBufferLow(bufferLength) {
      if (!state.hls) return;

      const currentLevel = state.hls.currentLevel;
      if (currentLevel > 0) {
        state.hls.currentLevel = currentLevel - 1;
      }

      const liveEdge = this._getLiveEdge();
      if (liveEdge > 0 && elements.video.currentTime < liveEdge - 5) {
        elements.video.currentTime = liveEdge - 1;
      }
    },

    _handleStall() {
      if (!state.hls) return;

      const video = elements.video;
      const liveEdge = this._getLiveEdge();

      if (liveEdge > 0) {
        video.currentTime = liveEdge - 0.5;
      } else {
        state.hls.startLoad();
      }

      this._stallCount = 0;
    },

    _getLiveEdge() {
      const video = elements.video;
      if (!video || !video.buffered.length) return 0;
      return video.buffered.end(video.buffered.length - 1);
    }
  };

  // ==================== MÓDULO: HLS ====================
  const HLSModule = {
    detectStreamType(url) {
      const lowerUrl = url.toLowerCase();
      if (lowerUrl.includes('.m3u8') || lowerUrl.includes('.ts')) {
        return 'hls';
      }
      return 'native';
    },

    getHlsConfig(lowLatencyMode) {
      if (lowLatencyMode) {
        return {
          enableWorker: true,
          lowLatencyMode: true,
          liveDurationInfinity: true,
          liveSyncDuration: 2,
          liveMaxLatencyDuration: 8,
          maxBufferLength: 20,
          maxMaxBufferLength: 40,
          backBufferLength: 30,
          liveBackBufferLength: 15,
          maxBufferSize: 10 * 1024 * 1024,
          startLevel: -1,
          capLevelToPlayerSize: true,
          highBufferWatchdogPeriod: 0.5,
          nudgeOffset: 0.1,
          nudgeMaxRetry: 5,
          maxSeekHole: 0.3,
          manifestLoadingRetryDelay: 300,
          manifestLoadingMaxRetry: 4,
          levelLoadingRetryDelay: 300,
          levelLoadingMaxRetry: 5,
          fragLoadingRetryDelay: 300,
          fragLoadingMaxRetry: 8,
          xhrSetup: function(xhr) {
            xhr.withCredentials = false;
          }
        };
      } else {
        return {
          enableWorker: true,
          lowLatencyMode: false,
          liveDurationInfinity: true,
          liveSyncDuration: 5,
          liveMaxLatencyDuration: 15,
          maxBufferLength: 30,
          maxMaxBufferLength: 60,
          backBufferLength: 60,
          liveBackBufferLength: 30,
          maxBufferSize: 20 * 1024 * 1024,
          startLevel: -1,
          capLevelToPlayerSize: true,
          highBufferWatchdogPeriod: 1,
          nudgeOffset: 0.1,
          nudgeMaxRetry: 8,
          maxSeekHole: 0.5,
          manifestLoadingRetryDelay: 800,
          manifestLoadingMaxRetry: 5,
          levelLoadingRetryDelay: 800,
          levelLoadingMaxRetry: 6,
          fragLoadingRetryDelay: 800,
          fragLoadingMaxRetry: 10,
          xhrSetup: function(xhr) {
            xhr.withCredentials = false;
          }
        };
      }
    },

    init(url, lowLatency) {
      const video = elements.video;
      if (!video) return;

      // Detecta tipo de stream
      state.streamType = this.detectStreamType(url);

      // Limpa instância anterior
      this.destroy();

      if (state.streamType === 'hls') {
        if (typeof Hls !== 'undefined' && Hls.isSupported()) {
          const config = this.getHlsConfig(lowLatency);
          const hls = new Hls(config);

          state.hls = hls;

          hls.loadSource(url);
          hls.attachMedia(video);

          // Evento: Manifest parseado
          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            state.levels = hls.levels;

            UIModule.showLiveBadge();
            this.updateQualityList();

            if (elements.lowLatencyLabel) {
              elements.lowLatencyLabel.style.display = 'flex';
            }

            UIModule.hideLoading();

            video.play().catch(() => {});

            StallMonitor.start();
          });

          // Evento: Troca de nível
          hls.on(Hls.Events.LEVEL_SWITCHED, (event, data) => {
            state.currentLevel = hls.currentLevel;
            this.updateQualityList();
          });

          // Evento: Erro
          hls.on(Hls.Events.ERROR, (event, data) => {
            if (data.fatal) {
              switch (data.type) {
                case Hls.ErrorTypes.NETWORK_ERROR:
                  if (data.response && data.response.code) {
                    if (data.response.code === 404) {
                      UIModule.showError();
                      this.updateErrorMessage('Canal não disponível', 'O conteúdo não foi encontrado no servidor (404)');
                      return;
                    } else if (data.response.code === 403) {
                      UIModule.showError();
                      this.updateErrorMessage('Acesso negado', 'O servidor bloqueou o acesso ao conteúdo (403)');
                      return;
                    }
                  }
                  hls.startLoad();
                  break;

                case Hls.ErrorTypes.MEDIA_ERROR:
                  hls.recoverMediaError();
                  break;

                default:
                  UIModule.showError();
                  this.updateErrorMessage('Erro ao reproduzir', `${data.details || 'Erro desconhecido'}`);
                  this.destroy();
                  break;
              }
            }
          });

        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
          video.src = url;
          state.streamType = 'native';

          video.addEventListener('loadedmetadata', () => {
            UIModule.hideLoading();
          });

          video.addEventListener('error', () => {
            UIModule.showError();
          });
        } else {
          UIModule.showError();
        }
      } else {
        video.src = url;

        video.addEventListener('loadedmetadata', () => {
          UIModule.hideLoading();
        });

        video.addEventListener('canplay', () => {
          UIModule.hideLoading();
        });

        video.addEventListener('error', () => {
          UIModule.showError();
        });

        video.load();
      }
    },

    destroy() {
      if (state.hls) {
        state.hls.destroy();
        state.hls = null;
      }
      StallMonitor.stop();
      state.levels = [];
      state.currentLevel = -1;
      UIModule.hideLiveBadge();
    },

    updateErrorMessage(title, message) {
      UIModule.updateErrorMessage(title, message);
    },

    changeQuality(levelIndex) {
      if (state.hls) {
        state.hls.currentLevel = levelIndex;
        state.currentLevel = levelIndex;
        this.updateQualityList();
      }
    },

    updateQualityList() {
      if (!elements.qualityList) return;

      if (state.levels.length === 0) {
        // Se não há níveis, mantém apenas a opção automática
        elements.qualityList.innerHTML = '<option value="-1">Automática</option>';
        return;
      }

      // Salva o estado de event listener
      const hasListener = elements.qualityList.hasAttribute('data-listener-attached');

      // Limpa as options atuais
      elements.qualityList.innerHTML = '';

      // Opção Automática
      const autoOption = document.createElement('option');
      autoOption.value = '-1';
      autoOption.textContent = 'Automática';
      elements.qualityList.appendChild(autoOption);

      // Níveis disponíveis
      state.levels.forEach((level, index) => {
        const option = document.createElement('option');
        option.value = index;
        option.textContent = `${level.height}p`;
        elements.qualityList.appendChild(option);
      });

      // Define o valor selecionado
      elements.qualityList.value = state.currentLevel.toString();

      // Adiciona event listener apenas uma vez
      if (!hasListener) {
        elements.qualityList.addEventListener('change', (e) => {
          const level = parseInt(e.target.value);
          this.changeQuality(level);
        });
        elements.qualityList.setAttribute('data-listener-attached', 'true');
      }
    },

    reinitialize() {
      const url = CHANNEL_DATA.url;
      this.init(url, state.lowLatencyMode);
    }
  };

  // ==================== MÓDULO: STATS ====================
  const StatsModule = {
    formatTime(seconds) {
      if (!isFinite(seconds) || seconds < 0) return '00:00';
      const mins = Math.floor(seconds / 60);
      const secs = Math.floor(seconds % 60);
      return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    },

    formatBitrate(bitrate) {
      if (!bitrate) return 'N/A';
      const kbps = bitrate / 1000;
      if (kbps >= 1000) {
        return `${(kbps / 1000).toFixed(2)} Mbps`;
      }
      return `${kbps.toFixed(0)} Kbps`;
    },

    getBufferLength() {
      const video = elements.video;
      if (!video || !video.buffered.length) return 0;

      try {
        const currentTime = video.currentTime;
        for (let i = 0; i < video.buffered.length; i++) {
          const start = video.buffered.start(i);
          const end = video.buffered.end(i);
          if (currentTime >= start && currentTime <= end) {
            return end - currentTime;
          }
        }
        return 0;
      } catch (error) {
        return 0;
      }
    },

    getLiveLatency() {
      if (!state.hls) return 0;

      try {
        if (typeof state.hls.latency === 'number') {
          return state.hls.latency;
        }

        const video = elements.video;
        if (video.buffered.length > 0) {
          const liveEdge = video.buffered.end(video.buffered.length - 1);
          const currentTime = video.currentTime;
          return liveEdge - currentTime;
        }

        return 0;
      } catch (error) {
        return 0;
      }
    },

    getPlaybackState() {
      const video = elements.video;
      if (!video) return 'N/A';
      if (video.paused) return 'Pausado';
      if (video.ended) return 'Finalizado';
      if (video.seeking) return 'Buscando...';
      if (video.readyState < 3) return 'Buffering...';
      return 'Reproduzindo';
    },

    update() {
      if (!state.showStats) {
        if (state.rafId) {
          cancelAnimationFrame(state.rafId);
          state.rafId = null;
        }
        return;
      }

      const now = performance.now();

      // Throttle: atualiza no máximo a cada 500ms
      if (now - state.lastStatsUpdate < 500) {
        state.rafId = requestAnimationFrame(() => this.update());
        return;
      }

      state.lastStatsUpdate = now;

      const video = elements.video;
      if (!video) return;

      // Resolução
      let resolution = 'N/A';
      let bitrate = 'N/A';
      let quality = 'N/A';
      let fps = 'N/A';

      if (state.hls && state.currentLevel >= 0 && state.hls.levels[state.currentLevel]) {
        const level = state.hls.levels[state.currentLevel];
        resolution = `${level.width}x${level.height}`;
        bitrate = this.formatBitrate(level.bitrate);
        quality = `Nível ${state.currentLevel} (${level.height}p)`;

        if (level.attrs && level.attrs['FRAME-RATE']) {
          fps = parseFloat(level.attrs['FRAME-RATE']).toFixed(0);
        }
      } else if (state.hls) {
        quality = 'Automático';
      }

      // Latência e buffer
      const latency = this.getLiveLatency();
      const latencyStr = latency > 0 ? `${latency.toFixed(2)}s` : 'N/A';

      const bufferLength = this.getBufferLength();
      const bufferStr = bufferLength > 0 ? `${bufferLength.toFixed(2)}s` : '0.00s';

      // Estado
      const playbackState = this.getPlaybackState();

      // Frames perdidos
      let droppedFrames = 0;
      let totalFrames = 0;
      if (video.getVideoPlaybackQuality) {
        try {
          const quality = video.getVideoPlaybackQuality();
          droppedFrames = quality.droppedVideoFrames || 0;
          totalFrames = quality.totalVideoFrames || 0;
        } catch (error) {
          // Silently fail
        }
      }

      // Tempo e velocidade
      const playbackTime = this.formatTime(video.currentTime);
      const playbackRate = `${video.playbackRate.toFixed(1)}x`;

      // Atualizar DOM
      this.updateDOM({
        resolution,
        bitrate,
        quality,
        fps,
        latency: latencyStr,
        buffer: bufferStr,
        state: playbackState,
        droppedFrames,
        totalFrames,
        playbackTime,
        playbackRate
      });

      // Agenda próxima atualização
      state.rafId = requestAnimationFrame(() => this.update());
    },

    updateDOM(stats) {
      const els = {
        resolution: document.getElementById('statResolution'),
        bitrate: document.getElementById('statBitrate'),
        quality: document.getElementById('statQuality'),
        fps: document.getElementById('statFps'),
        latency: document.getElementById('statLatency'),
        buffer: document.getElementById('statBuffer'),
        state: document.getElementById('statState'),
        frames: document.getElementById('statFrames'),
        time: document.getElementById('statTime'),
        rate: document.getElementById('statRate')
      };

      if (els.resolution) els.resolution.textContent = stats.resolution;
      if (els.bitrate) els.bitrate.textContent = stats.bitrate;
      if (els.quality) els.quality.textContent = stats.quality;
      if (els.fps) els.fps.textContent = stats.fps;

      // Latência com highlight
      if (els.latency) {
        els.latency.textContent = stats.latency;
        const latencyVal = parseFloat(stats.latency);
        if (!isNaN(latencyVal)) {
          els.latency.className = latencyVal > 5 ? 'player__stats-value player__stats-value--warn' : 'player__stats-value';
        }
      }

      // Buffer com highlight
      if (els.buffer) {
        els.buffer.textContent = stats.buffer;
        const bufferVal = parseFloat(stats.buffer);
        if (!isNaN(bufferVal)) {
          els.buffer.className = bufferVal < 1 ? 'player__stats-value player__stats-value--warn' : 'player__stats-value';
        }
      }

      if (els.state) els.state.textContent = stats.state;

      // Frames com highlight
      if (els.frames) {
        if (stats.totalFrames > 0) {
          els.frames.textContent = `${stats.droppedFrames} / ${stats.totalFrames}`;
          els.frames.className = stats.droppedFrames > 0 ? 'player__stats-value player__stats-value--error' : 'player__stats-value';
        } else {
          els.frames.textContent = 'N/A';
        }
      }

      if (els.time) els.time.textContent = stats.playbackTime;
      if (els.rate) els.rate.textContent = stats.playbackRate;
    },

    start() {
      if (!state.showStats) return;
      this.update();
    },

    stop() {
      if (state.rafId) {
        cancelAnimationFrame(state.rafId);
        state.rafId = null;
      }
    }
  };

  // ==================== MÓDULO: CONTROLS ====================
  const ControlsModule = {
    initPlayPause() {
      if (!elements.playBtn) return;

      elements.playBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.togglePlay();
      });
    },

    togglePlay() {
      const video = elements.video;
      if (!video) return;

      if (video.paused) {
        // Ao despausar, volta para o ponto ao vivo
        if (video.buffered.length > 0) {
          const livePosition = video.buffered.end(video.buffered.length - 1);
          video.currentTime = livePosition;
        }

        video.play();
        state.isPlaying = true;
        UIModule.updatePlayButton(true);
        this.resetControlsTimer();
      } else {
        video.pause();
        state.isPlaying = false;
        UIModule.updatePlayButton(false);
        UIModule.showUIElements();
      }
    },

    initVolume() {
      if (!elements.volumeBtn || !elements.volumeRange) return;

      // Carregar configurações persistidas
      state.volume = StorageModule.getVolume();
      state.isMuted = StorageModule.getMuted();

      // Aplicar no vídeo
      elements.video.volume = state.volume;
      elements.video.muted = state.isMuted;
      elements.volumeRange.value = state.volume;

      // Atualizar UI
      UIModule.updateVolumeIcon(state.volume, state.isMuted);
      UIModule.updateVolumeFill(state.volume);

      // Botão mute
      elements.volumeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggleMute();
      });

      // Slider
      elements.volumeRange.addEventListener('input', (e) => {
        e.stopPropagation();
        const value = parseFloat(e.target.value);
        this.updateVolume(value);

        // Se ajustar volume, desmuta automaticamente
        if (state.isMuted && value > 0) {
          state.isMuted = false;
          elements.video.muted = false;
          StorageModule.setMuted(false);
          UIModule.updateVolumeIcon(value, false);
        }
      });
    },

    toggleMute() {
      state.isMuted = !state.isMuted;
      elements.video.muted = state.isMuted;
      StorageModule.setMuted(state.isMuted);
      UIModule.updateVolumeIcon(state.volume, state.isMuted);
    },

    updateVolume(value) {
      const clampedValue = Math.max(0, Math.min(1, value));
      state.volume = clampedValue;
      elements.video.volume = clampedValue;
      StorageModule.setVolume(clampedValue);
      UIModule.updateVolumeFill(clampedValue);
      UIModule.updateVolumeIcon(clampedValue, state.isMuted);
    },

    initFullscreen() {
      if (!elements.fullscreenBtn) return;

      elements.fullscreenBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggleFullscreen();
      });

      // Listener para mudanças no fullscreen
      document.addEventListener('fullscreenchange', () => {
        state.isFullscreen = !!document.fullscreenElement;
        UIModule.updateFullscreenIcon(state.isFullscreen);
      });
    },

    toggleFullscreen() {
      if (!elements.container) return;

      if (document.fullscreenElement) {
        document.exitFullscreen();
      } else {
        elements.container.requestFullscreen();
      }
    },

    initPiP() {
      if (!elements.pipBtn) return;

      elements.pipBtn.addEventListener('click', async (e) => {
        e.stopPropagation();

        const video = elements.video;
        if (!video) return;

        try {
          if (document.pictureInPictureElement) {
            await document.exitPictureInPicture();
          } else {
            await video.requestPictureInPicture();
          }
        } catch (error) {
          // PiP não suportado ou bloqueado
        }
      });
    },

    initSettings() {
      if (!elements.settingsBtn) return;

      elements.settingsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        UIModule.toggleSettingsMenu();
      });

      // Fechar ao clicar fora
      document.addEventListener('click', (e) => {
        if (elements.settingsMenu && !elements.settingsMenu.contains(e.target) && e.target !== elements.settingsBtn) {
          UIModule.closeSettingsMenu();
        }
      });

      // Checkbox: Baixa Latência
      if (elements.lowLatencyCheckbox) {
        elements.lowLatencyCheckbox.checked = state.lowLatencyMode;

        elements.lowLatencyCheckbox.addEventListener('change', (e) => {
          state.lowLatencyMode = e.target.checked;
          StorageModule.setLowLatency(state.lowLatencyMode);

          HLSModule.reinitialize();
        });
      }

      // Checkbox: Estatísticas
      if (elements.showStatsCheckbox) {
        elements.showStatsCheckbox.checked = state.showStats;

        elements.showStatsCheckbox.addEventListener('change', (e) => {
          state.showStats = e.target.checked;
          StorageModule.setShowStats(state.showStats);

          if (state.showStats) {
            UIModule.showStats();
            StatsModule.start();
          } else {
            UIModule.hideStats();
            StatsModule.stop();
          }
        });
      }
    },

    resetControlsTimer() {
      UIModule.showUIElements();

      if (state.hideTimeout) {
        clearTimeout(state.hideTimeout);
      }

      state.hideTimeout = setTimeout(() => {
        if (!elements.video.paused) {
          UIModule.hideUIElements();
        }
      }, 2500);
    },

    initAutoHide() {
      if (!elements.container) return;

      elements.container.addEventListener('mousemove', () => {
        this.resetControlsTimer();
      });

      // Auto-hide inicial
      this.resetControlsTimer();
    },

    handlePlayerClick() {
      state.clickCount++;

      if (state.clickCount === 1) {
        state.clickTimeout = setTimeout(() => {
          // Single click: Play/Pause
          this.togglePlay();
          state.clickCount = 0;
        }, 250);
      } else if (state.clickCount === 2) {
        // Double click: Fullscreen
        clearTimeout(state.clickTimeout);
        this.toggleFullscreen();
        state.clickCount = 0;
      }
    },

    initClickHandling() {
      if (!elements.container) return;

      elements.container.addEventListener('click', (e) => {
        // Ignora cliques em controles
        if (e.target.closest('.player__controls') ||
          e.target.closest('.player__settings-menu')) {
          return;
        }

        this.handlePlayerClick();
      });
    }
  };

  // ==================== MÓDULO: KEYBOARD ====================
  const KeyboardModule = {
    handleKeyPress(e) {
      // Evita conflito com inputs
      const target = e.target;
      if (target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable) {
        return;
      }

      const key = e.key.toLowerCase();

      switch (key) {
        case 'k':
        case ' ':
          e.preventDefault();
          ControlsModule.togglePlay();
          break;

        case 'f':
          e.preventDefault();
          ControlsModule.toggleFullscreen();
          break;

        case 'm':
          e.preventDefault();
          ControlsModule.toggleMute();
          break;
      }
    },

    init() {
      if (state.keyboardListenersAttached) return;

      document.addEventListener('keydown', (e) => this.handleKeyPress(e));
      state.keyboardListenersAttached = true;
    }
  };

  // ==================== INICIALIZAÇÃO ====================
  function initPlayer() {
    // 1. Cache de elementos
    UIModule.init();

    // 2. Carregar configurações persistidas
    state.lowLatencyMode = StorageModule.getLowLatency();
    state.showStats = StorageModule.getShowStats();

    // 3. Inicializar HLS
    HLSModule.init(CHANNEL_DATA.url, state.lowLatencyMode);

    // 4. Inicializar controles
    ControlsModule.initPlayPause();
    ControlsModule.initVolume();
    ControlsModule.initFullscreen();
    ControlsModule.initPiP();
    ControlsModule.initSettings();
    ControlsModule.initAutoHide();
    ControlsModule.initClickHandling();

    // 5. Inicializar atalhos de teclado
    KeyboardModule.init();

    // 6. Inicializar stats (se habilitado)
    if (state.showStats) {
      UIModule.showStats();
      StatsModule.start();
    }

    // 7. Event listeners do vídeo
    if (elements.video) {
      elements.video.addEventListener('waiting', () => {
        UIModule.showLoading();
      });

      elements.video.addEventListener('playing', () => {
        UIModule.hideLoading();
        UIModule.hideError();
        state.isPlaying = true;
        UIModule.updatePlayButton(true);
      });

      elements.video.addEventListener('pause', () => {
        state.isPlaying = false;
        UIModule.updatePlayButton(false);
      });

      elements.video.addEventListener('play', () => {
        state.isPlaying = true;
        UIModule.updatePlayButton(true);
      });

      elements.video.addEventListener('stalled', () => {
        if (state.hls) {
          const bufferLen = StatsModule.getBufferLength();
          if (bufferLen < 2) {
            const liveEdge = elements.video.buffered.length > 0
              ? elements.video.buffered.end(elements.video.buffered.length - 1)
              : 0;
            if (liveEdge > 0) {
              elements.video.currentTime = liveEdge - 0.5;
            } else {
              state.hls.startLoad();
            }
          }
        }
      });
    }
  }

  // ==================== CLEANUP ====================
  function cleanup() {
    HLSModule.destroy();
    StatsModule.stop();
    StallMonitor.stop();

    if (state.hideTimeout) {
      clearTimeout(state.hideTimeout);
    }

    if (state.clickTimeout) {
      clearTimeout(state.clickTimeout);
    }
  }

  // ==================== EVENTOS GLOBAIS ====================
  window.addEventListener('load', initPlayer);
  window.addEventListener('beforeunload', cleanup);

})();
