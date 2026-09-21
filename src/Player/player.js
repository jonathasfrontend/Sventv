/**
 * SvenTV Advanced Player - Vanilla JavaScript
 * Converted from React/Next.js with full feature preservation
 * 
 * Features:
 * - HLS.js streaming with adaptive bitrate
 * - Custom Twitch-style controls
 * - Low latency mode
 * - Quality selection (persistida)
 * - localStorage persistence
 * - Keyboard shortcuts
 * - Click/Double-click handling
 * - Auto-hide controls
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
    pipBtn: null,
    fullscreenBtn: null,
    fullscreenIcon: null,
    liveBadge: null,
    loading: null,
    errorMessage: null,
    channelInfo: null,
    epgBar: null
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
    isFullscreen: false,
    showControls: true,
    hideTimeout: null,
    clickCount: 0,
    clickTimeout: null,
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
    getVolume() {
      const vol = parseFloat(this.get('player_volume', '1'));
      return isNaN(vol) ? 1 : Math.max(0, Math.min(1, vol));
    },

    getMuted() {
      return this.get('player_muted', false) === true || this.get('player_muted', false) === 'true';
    },

    setVolume(value) {
      this.set('player_volume', value);
    },

    setMuted(value) {
      this.set('player_muted', value);
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
      elements.pipBtn = document.getElementById('pipBtn');
      elements.fullscreenBtn = document.getElementById('fullscreenBtn');
      elements.fullscreenIcon = document.getElementById('fullscreenIcon');
      elements.liveBadge = document.getElementById('liveBadge');
      elements.loading = document.getElementById('loading');
      elements.errorMessage = document.getElementById('errorMessage');
      elements.channelInfo = document.getElementById('channelInfo');
      elements.epgBar = document.getElementById('epgBar');
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
      // A barra de EPG segue o mesmo ciclo visual dos controles (quando
      // visível — canais sem EPG continuam com o atributo `hidden`).
      if (elements.epgBar) {
        elements.epgBar.classList.remove('player__ui-element--hidden');
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
        if (elements.epgBar) {
          elements.epgBar.classList.add('player__ui-element--hidden');
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

    updateErrorMessage(title, message) {
      if (elements.errorMessage) {
        const titleEl = elements.errorMessage.querySelector('.player__error-title');
        const messageEl = elements.errorMessage.querySelector('.player__error-message');
        
        if (titleEl) titleEl.textContent = title;
        if (messageEl) messageEl.textContent = message;
      }
    }
  };

  // ==================== HELPERS ====================
  function getBufferLength() {
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
  }

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
      const bufferLength = getBufferLength();
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
    MAX_AUTO_RETRIES: 2,

    detectStreamType(url) {
      const format = (typeof CHANNEL_DATA !== 'undefined' && CHANNEL_DATA.format) || '';
      if (String(format).toLowerCase().includes('hls')) return 'hls';
      const lowerUrl = url.toLowerCase();
      if (lowerUrl.includes('.m3u8') || lowerUrl.includes('.ts') || lowerUrl.includes('/proxy')) {
        return 'hls';
      }
      return 'native';
    },

    getHlsConfig() {
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
        manifestLoadingTimeOut: 30000,
        manifestLoadingRetryDelay: 1000,
        manifestLoadingMaxRetry: 5,
        manifestLoadingMaxRetryDelay: 8000,
        levelLoadingRetryDelay: 800,
        levelLoadingMaxRetry: 6,
        fragLoadingRetryDelay: 800,
        fragLoadingMaxRetry: 10,
        xhrSetup: function(xhr) {
          xhr.withCredentials = false;
        }
      };
    },

    init(url, isRecovery) {
      const video = elements.video;
      if (!video) return;

      this._currentUrl = url || this._currentUrl || CHANNEL_DATA.url;
      state.streamType = this.detectStreamType(this._currentUrl);
      this.destroy();
      if (!isRecovery) this.recoveryAttempts = 0;

      if (state.streamType === 'hls') {
        if (typeof Hls !== 'undefined' && Hls.isSupported()) {
          const config = this.getHlsConfig();
          const hls = new Hls(config);
          state.hls = hls;

          hls.loadSource(this._currentUrl);
          hls.attachMedia(video);

          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            state.levels = hls.levels;
            this.recoveryAttempts = 0;
            UIModule.showLiveBadge();
            UIModule.hideLoading();
            video.play().catch(() => {});
            StallMonitor.start();
          });

          hls.on(Hls.Events.LEVEL_SWITCHED, () => {
            state.currentLevel = hls.currentLevel;
          });

          hls.on(Hls.Events.ERROR, (_event, data) => {
            if (!data.fatal) return;
            switch (data.type) {
              case Hls.ErrorTypes.NETWORK_ERROR:
                this._handleNetworkError(data);
                break;
              case Hls.ErrorTypes.MEDIA_ERROR:
                hls.recoverMediaError();
                break;
              default:
                this._showFatal('Erro ao reproduzir', data.details || 'Erro desconhecido');
                break;
            }
          });

        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
          this._playNative(this._currentUrl);
        } else {
          this._showFatal('Erro ao reproduzir', 'O navegador não suporta este formato de vídeo.');
        }
      } else {
        this._playNative(this._currentUrl);
      }
    },

    _handleNetworkError(data) {
      const code = data && data.response && data.response.code;

      if (code === 404) {
        return this._showFatal('Canal não disponível', 'O conteúdo não foi encontrado no servidor (404).');
      }
      if (code === 403) {
        return this._showFatal('Acesso negado', 'O servidor bloqueou o acesso ao conteúdo (403).');
      }
      if (code === 429) {
        return this._showFatal('Limite de streams atingido', 'Você já tem o número máximo de streams abertos nesta conta. Feche outra aba/player e tente novamente.');
      }

      if (typeof code === 'number' && code >= 400) {
        if (this.recoveryAttempts < 1) {
          this._scheduleRecovery(1200);
          return;
        }
        return this._showFatal('Erro ao reproduzir', 'A fonte do stream não está disponível. Tente novamente mais tarde.');
      }

      if (this.recoveryAttempts < this.MAX_AUTO_RETRIES) {
        this._scheduleRecovery(600 * (this.recoveryAttempts + 1));
        return;
      }

      this._showFatal('Erro de reprodução', 'Erro de rede. Tente novamente mais tarde.');
    },

    _scheduleRecovery(delayMs) {
      this.recoveryAttempts++;
      const url = this._currentUrl || (typeof CHANNEL_DATA !== 'undefined' && CHANNEL_DATA.url);
      const self = this;
      setTimeout(() => self.init(url, true), delayMs);
    },

    _playNative(url) {
      const video = elements.video;
      if (!video) return;

      const onMeta = () => {
        UIModule.hideLoading();
        this.recoveryAttempts = 0;
      };
      const onCanPlay = () => {
        UIModule.hideLoading();
        this.recoveryAttempts = 0;
      };

      video.removeEventListener('loadedmetadata', this._onNativeMeta);
      video.removeEventListener('canplay', this._onNativeCanPlay);
      video.removeEventListener('error', this._onNativeError);

      this._onNativeMeta = onMeta;
      this._onNativeCanPlay = onCanPlay;
      this._onNativeError = () => {
        if (this.recoveryAttempts < this.MAX_AUTO_RETRIES) {
          this.recoveryAttempts++;
          const wait = 600 * this.recoveryAttempts;
          const target = this._currentUrl || url;
          setTimeout(() => {
            if (elements.video) {
              elements.video.src = target;
              elements.video.load();
            }
          }, wait);
          return;
        }
        UIModule.hideLoading();
        UIModule.updateErrorMessage('Erro de reprodução', 'Erro de rede. Tente novamente mais tarde.');
        UIModule.showError();
      };

      video.addEventListener('loadedmetadata', onMeta);
      video.addEventListener('canplay', onCanPlay);
      video.addEventListener('error', this._onNativeError);

      video.src = url;
      video.load();
    },

    _showFatal(title, message) {
      UIModule.hideLoading();
      UIModule.updateErrorMessage(title, message);
      UIModule.showError();
      this.destroy();
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
    }
  };

  // ==================== MÓDULO: ANALYTICS DE REPRODUÇÃO ====================
  // Envia transições discretas (play/pause/resume/stop/ended) e heartbeats
  // para /api/playback/* usando o token do próprio player (playback ou API).
  // Heartbeats (30s) atualizam a sessão SEM gerar linha de evento.
  const AnalyticsModule = (() => {
    const channelId = (CHANNEL_DATA && CHANNEL_DATA.id) || '';
    const token = (() => {
      try {
        return new URL(CHANNEL_DATA.url, window.location.origin).searchParams.get('token') || '';
      } catch (_) { return ''; }
    })();

    // Sem canal ou sem token na URL → não instrumenta (embed sem sessão).
    if (!channelId || !token) return null;

    const HEARTBEAT_MS = 30000; // alinhado a config.analytics.heartbeatIntervalMs
    const sessionId = (() => {
      try {
        return (window.crypto && window.crypto.randomUUID)
          ? window.crypto.randomUUID()
          : 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
      } catch (_) {
        return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
      }
    })();

    let started = false;
    let heartbeatTimer = null;

    const currentMs = () => Math.floor((elements.video && elements.video.currentTime || 0) * 1000);

    async function post(path, body) {
      try {
        await fetch(path, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + token,
          },
          body: JSON.stringify(body),
          keepalive: true,
        });
      } catch (_) { /* analytics não pode quebrar o player */ }
    }

    function sendEvent(event) {
      post('/api/playback/events', {
        sessionId,
        channelId,
        event,
        watchDurationMs: currentMs(),
      });
    }

    function startHeartbeat() {
      stopHeartbeat();
      heartbeatTimer = setInterval(() => {
        if (elements.video && !elements.video.paused) {
          post('/api/playback/heartbeat', {
            sessionId,
            channelId,
            watchDurationMs: currentMs(),
          });
        }
      }, HEARTBEAT_MS);
    }

    function stopHeartbeat() {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    }

    return {
      trackStarted() {
        if (started) return;
        started = true;
        sendEvent('play');
        startHeartbeat();
      },
      onPause() {
        if (!started) return;
        sendEvent('pause');
      },
      onResume() {
        if (!started) return;
        sendEvent('resume');
      },
      onEnded() {
        if (!started) return;
        started = false;
        sendEvent('ended');
        stopHeartbeat();
      },
      onStop() {
        if (!started) return;
        started = false;
        sendEvent('stop');
        stopHeartbeat();
      },
    };
  })();

  // ==================== MÓDULO: MARCA D'ÁGUA ====================
  // Código visual derivado da sessão (sem dados pessoais) que rotaciona
  // entre os cantos para desencorajar captura/redistribuição do stream.
  const WatermarkModule = {
    _el: null,
    _timer: null,
    _positions: ['tr', 'br', 'bl', 'tl'],
    _pos: 0,

    _sessionShort() {
      try {
        if (window.crypto && window.crypto.randomUUID) {
          return window.crypto.randomUUID().replace(/-/g, '').slice(0, 4).toUpperCase();
        }
      } catch (_) { /* fallback abaixo */ }
      return Math.random().toString(36).slice(2, 6).toUpperCase();
    },

    _deviceId() {
      return '#' + Math.random().toString(36).slice(2, 7).toUpperCase();
    },

    buildHTML() {
      return '<span class="player__watermark-line">SvenTV</span>' +
        '<span class="player__watermark-line" hidden>ID: ' + this._deviceId() + '</span>' +
        '<span class="player__watermark-line" hidden>Session: ' + this._sessionShort() + '</span>';
    },

    start() {
      this._el = document.getElementById('watermark');
      if (!this._el) return;
      this._el.innerHTML = this.buildHTML();
      this._pos = Math.floor(Math.random() * this._positions.length);
      this._apply();
      this._timer = setInterval(() => {
        this._pos = (this._pos + 1) % this._positions.length;
        this._apply();
      }, 45000);
    },

    _apply() {
      if (!this._el) return;
      this._el.className = 'player__watermark player__watermark--' + this._positions[this._pos];
    },

    setPaused(paused) {
      if (!this._el) return;
      this._el.classList.toggle('player__watermark--paused', !!paused);
    },

    stop() {
      if (this._timer) clearInterval(this._timer);
      this._timer = null;
      this._el = null;
    }
  };

  // ==================== MÓDULO: BOTÃO "AVISE-ME" ====================
  // Ativa um lembrete para o PRÓXIMO programa da barra de EPG (nunca o atual).
  // A lógica pura (payload/horizonte) vive em ReminderBarCore (testável);
  // aqui só DOM + fetch. Nenhum dado de EPG é interpolado em HTML (100%
  // element.textContent / criação de elemento) — conteúdo externo é texto.
  // O POST usa credentials:'include' (session cookie do painel) e, quando o
  // stream foi autenticado com API token, também Authorization: Bearer.
  //
  // Estado persistido: após ativar, o servidor marca o lembrete (banco + Redis)
  // e o botão NÃO reaparece ao reabrir o player. A identidade é por PROGRAMA
  // (canal + hora de início, NUNCA pelo título): outro programa com o mesmo
  // nome e início diferente é um lembrete novo → o botão volta e um novo
  // lembrete é armazenado (não reusa o estado salvo anterior).
  const ReminderModule = (() => {
    const channelId = (CHANNEL_DATA && CHANNEL_DATA.id) || '';
    const canRemind = Boolean(typeof CHANNEL_DATA !== 'undefined' && CHANNEL_DATA.canRemind);
    const reminderAuth = String((CHANNEL_DATA && CHANNEL_DATA.reminderAuth) || 'session').toLowerCase() === 'api'
      ? 'api'
      : 'session';

    let slot = null;
    let btn = null;
    let msg = null;
    let next = null;            // programa "próximo" corrente (salvo no update)
    let lastView = null;        // última view renderizada (re-render pós-status)
    let busy = false;
    let subStart = null;        // início do lembrado nesta sessão (mensagem persistente)
    const activeStarts = new Map();  // startMs → true (servidor confirmou existência)
    const pendingStarts = new Set(); // startMs → consulta de status em andamento

    // Dispatcher "Avise-me" (public/js/reminder-notifier.js): a notificação
    // do navegador é disparada por ele mesmo — ao contrário do Realtime, ele
    // NÃO pausa em aba oculta, então avisa mesmo com o usuário em outra aba.
    const NOTIFIER_INTERVAL_MS = 30 * 1000;
    const NOTIFIER_LEAD_MS = 60 * 1000;      // até 60s antes do início
    const NOTIFIER_TRAIL_MS = 15 * 60 * 1000; // recupera até 15min após
    let notifierActive = false;

    function cacheElements() {
      slot = document.getElementById('reminderSlot');
      if (!slot) return;
      // Botão/mensagem são estáticos (nenhum dado externo) — criados no JS
      // para não poluir o template; texto via textContent.
      btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'player__reminder-btn';
      btn.textContent = 'Avise-me';
      btn.hidden = true;
      btn.title = 'Receber um lembrete quando este programa começar';
      msg = document.createElement('span');
      msg.className = 'player__reminder-msg';
      msg.hidden = true;
      slot.appendChild(btn);
      slot.appendChild(msg);
    }

    function setMessage(text) {
      if (!msg) return;
      msg.textContent = text;
      msg.hidden = !text;
    }

    function authHeaders(json) {
      const headers = {};
      if (json) headers['Content-Type'] = 'application/json';
      if (reminderAuth === 'api') {
        try {
          const token = new URL(CHANNEL_DATA.url, window.location.origin).searchParams.get('token') || '';
          if (token) headers['Authorization'] = 'Bearer ' + token;
        } catch (_) { /* sem token → só cookie */ }
      }
      return headers;
    }

    function statusUrl(startMs) {
      return '/api/user/reminders/status?channelId=' + encodeURIComponent(channelId) +
        '&startsAt=' + encodeURIComponent(String(startMs));
    }

    /**
     * Estado persistido do botão: pergunta ao servidor (banco + Redis) se já
     * existe lembrete para (canal, início deste próximo programa). UMA consulta
     * por programa; falha ou 401 → fail-open (botão fica, o POST diria 409).
     */
    function resolveStatus(startMs) {
      if (!canRemind || startMs == null) return;
      if (activeStarts.has(startMs) || pendingStarts.has(startMs)) return;
      pendingStarts.add(startMs);
      fetch(statusUrl(startMs), { headers: authHeaders(false), credentials: 'include' })
        .then((res) => (res.ok ? res.json() : null))
        .then((json) => {
          if (json && json.data && json.data.active) {
            activeStarts.set(startMs, true);
            if (lastView) update(lastView);
          }
        })
        .catch(() => { /* fail-open: mantém o botão */ })
        .finally(() => { pendingStarts.delete(startMs); });
    }

    function isActive(startMs) {
      return startMs != null && (activeStarts.has(startMs) || subStart === startMs);
    }

    /**
     * Chamado a cada render da barra de EPG: mostra/esconde o botão conforme
     * exista um próximo programa sugerível, ainda não lembrado — checando o
     * estado persistido (para o botão não ressurgir ao reabrir o player).
     */
    function update(view) {
      if (!btn || !msg) return;
      lastView = view;
      next = (view && view.next && ReminderBarCore.shouldSuggestReminder(view.next, Date.now()))
        ? view.next
        : null;
      const start = next ? ReminderBarCore.toEpochMs(next.start) : null;
      if (next && start != null) resolveStatus(start);
      const active = isActive(start);
      const visible = canRemind && !active && Boolean(next) && start != null;
      btn.hidden = !visible;
      setMessage(!visible && active && start != null ? 'Lembrete ativado' : '');
    }

    function onRemind() {
      if (!next || busy) return;
      const payload = ReminderBarCore.buildPayload({ channelId, programme: next });
      if (!payload) return;
      const start = ReminderBarCore.toEpochMs(next.start);
      if (isActive(start)) return;

      // Notificação do navegador exige permissão — o clique do botão é o
      // gesto do usuário; pedimos aqui quando ainda está em 'default'.
      if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
        Notification.requestPermission().catch(() => { /* user cancelou */ });
      }

      busy = true;
      btn.disabled = true;
      setMessage('');

      fetch('/api/user/reminders', {
        method: 'POST',
        headers: authHeaders(true),
        credentials: 'include', // session cookie httpOnly (mesma origem)
        body: JSON.stringify(payload),
      })
        .then((res) => {
          if (res.status === 201 || res.status === 409) {
            // 201 criado; 409 = já existe lembrete para canal+início → idem sucesso.
            subStart = start;
            activeStarts.set(start, true);
            const granted = typeof Notification !== 'undefined' && Notification.permission === 'granted';
            setMessage(granted
              ? 'Lembrete ativado'
              : 'Lembrete ativado. Permita as notificações do navegador para receber o aviso.');
            update(lastView || null); // esconde o botão para ESTE programa
            return;
          }
          if (res.status === 401) {
            setMessage('Faça login para ativar lembretes.');
            return;
          }
          setMessage('Não foi possível ativar. Tente novamente.');
        })
        .catch(() => {
          setMessage('Não foi possível ativar. Tente novamente.');
        })
        .finally(() => {
          busy = false;
          btn.disabled = false;
        });
    }

    function init() {
      if (!canRemind) return; // kill switch da feature → nada é renderizado
      cacheElements();
      if (!btn) return;
      // Dispatcher do navegador: avisa no horário do programa mesmo com o
      // usuário em outra aba (não pausa em aba oculta). Reusa a auth do
      // botão — API token (Bearer) ou cookie httpOnly da sessão.
      if (typeof ReminderNotifier !== 'undefined' && ReminderNotifier.start) {
        ReminderNotifier.start({
          headers: reminderAuth === 'api' ? () => authHeaders(false) : null,
          credentials: 'include',
          clickUrl: '/guia',
          intervalMs: NOTIFIER_INTERVAL_MS,
          leadMs: NOTIFIER_LEAD_MS,
          trailMs: NOTIFIER_TRAIL_MS,
        });
        notifierActive = true;
      }
      btn.addEventListener('click', onRemind);
    }

    function destroy() {
      if (btn) {
        btn.removeEventListener('click', onRemind);
        if (btn.parentNode) btn.parentNode.removeChild(btn);
      }
      if (notifierActive && typeof ReminderNotifier !== 'undefined' && ReminderNotifier.stop) {
        ReminderNotifier.stop();
      }
      notifierActive = false;
      if (slot) slot.innerHTML = '';
      slot = null;
      btn = null;
      msg = null;
      next = null;
      lastView = null;
      subStart = null;
      activeStarts.clear();
      pendingStarts.clear();
    }

    return { init, update, destroy };
  })();

  // ==================== MÓDULO: BARRA DE EPG ====================
  // EPG embutido server-side em CHANNEL_DATA.epg (janela agora − 1h →
  // agora + 12h). NENHUM fetch durante a reprodução: atualização 100%
  // local via setInterval. Conteúdo de EPG é TEXTO externo — renderizado
  // com textContent, nunca innerHTML (previne XSS via XMLTV).
  const EPGModule = (() => {
    const INTERVAL_MS = 30000; // atualização local de now (sem rede)

    let list = [];
    let hasEpg = false;
    let timer = null;

    let bar = null;
    let nowTitle = null;
    let nowMeta = null;
    let nextTitle = null;
    let nextTime = null;
    let progressFill = null;

    function cacheElements() {
      bar = document.getElementById('epgBar');
      nowTitle = document.getElementById('epgNowTitle');
      nowMeta = document.getElementById('epgNowMeta');
      nextTitle = document.getElementById('epgNextTitle');
      nextTime = document.getElementById('epgNextTime');
      progressFill = document.getElementById('epgProgressFill');
    }

    function init() {
      cacheElements();
      if (!bar) return;

      const raw = (typeof CHANNEL_DATA !== 'undefined' && CHANNEL_DATA.epg) || [];
      // Normalização/validação e ordenação (start ASC) em uma passada.
      list = (typeof EpgBarCore !== 'undefined' && EpgBarCore.normalizeProgrammes)
        ? EpgBarCore.normalizeProgrammes(raw)
        : [];

      hasEpg = list.length > 0;
      if (!hasEpg) {
        // EPG desativado, sem cache, canal sem match ou dados inválidos →
        // barra permanentemente oculta. Sem mensagem de "sem programação".
        ReminderModule.update(null); // sem programação → sem botão "Avise-me"
        return;
      }

      bar.hidden = false;
      render();
      timer = setInterval(render, INTERVAL_MS);
    }

    function render() {
      if (!hasEpg || !bar) return;

      const now = Date.now();
      const view = EpgBarCore.computeView(list, now);

      // Passando agora
      if (view.current) {
        nowTitle.textContent = view.current.title;
        if (nowMeta) {
          nowMeta.textContent = view.current.description || view.current.subtitle || '';
          nowMeta.hidden = !(view.current.description || view.current.subtitle);
        }
        const pct = EpgBarCore.computeProgress(view.current, now);
        if (progressFill) progressFill.style.width = Math.round(pct * 10) / 10 + '%';
      } else {
        // Gap: nenhum programa cobre `now`.
        nowTitle.textContent = 'Sem programação no momento';
        if (nowMeta) {
          nowMeta.textContent = '';
          nowMeta.hidden = true;
        }
        if (progressFill) progressFill.style.width = '0%';
      }

      // Próximo
      if (view.next) {
        nextTitle.textContent = view.next.title;
        nextTitle.hidden = false;
        if (nextTime) {
          nextTime.textContent = formatTime(view.next.start);
          nextTime.hidden = false;
        }
      } else {
        // Dados exauridos: oculta o próximo (nunca faz nova requisição).
        nextTitle.hidden = true;
        if (nextTime) nextTime.hidden = true;
      }

      // Botão "Avise-me" reflete o próximo programa corrente (o atual nunca).
      ReminderModule.update(view);
    }

    function formatTime(ms) {
      try {
        return new Date(ms).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      } catch (_) {
        return '';
      }
    }

    function destroy() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      ReminderModule.destroy(); // botão "Avise-me" morre junto com a barra
      list = [];
      hasEpg = false;
    }

    return { init, render, destroy };
  })();

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
        if (e.target.closest('.player__controls')) {
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

    // Estado administrativo do canal: em manutenção/bloqueado o player não
    // tenta abrir o HLS (evita retry infinito) e exibe a mensagem correta.
    const channelState = (typeof CHANNEL_DATA !== 'undefined' && CHANNEL_DATA.state) || 'live';
    if (channelState !== 'live') {
      const info = channelState === 'blocked'
        ? { title: 'Canal bloqueado', message: 'Este canal foi bloqueado e não está disponível para reprodução.' }
        : { title: 'Canal em manutenção', message: 'Este canal está em manutenção no momento. Tente novamente mais tarde.' };
      UIModule.hideLoading();
      UIModule.updateErrorMessage(info.title, info.message);
      UIModule.showError();
      return;
    }

    // 2. Inicializar HLS
    HLSModule.init(CHANNEL_DATA.url);

    // 3. Inicializar controles
    ControlsModule.initPlayPause();
    ControlsModule.initVolume();
    ControlsModule.initFullscreen();
    ControlsModule.initPiP();
    ControlsModule.initAutoHide();
    ControlsModule.initClickHandling();

    // 4. Marca d'água de sessão
    WatermarkModule.start();

    // 5. Barra de EPG (agora / próximo / progresso) — alimentada pelos
    //    dados embutidos; sem rede. Canal sem EPG → barra fica oculta.
    //    O botão "Avise-me" (que vive na barra) precisa de init ANTES do
    //    primeiro render do EPGModule para sincronizar a visibilidade.
    ReminderModule.init();
    EPGModule.init();

    // 6. Inicializar atalhos de teclado
    KeyboardModule.init();

    // 7. Event listeners do vídeo
    if (elements.video) {
      elements.video.addEventListener('waiting', () => {
        UIModule.showLoading();
      });

      // Analytics: reprodução efetivamente iniciada (autoplay inicial).
      elements.video.addEventListener('playing', () => {
        UIModule.hideLoading();
        UIModule.hideError();
        state.isPlaying = true;
        UIModule.updatePlayButton(true);
        HLSModule.recoveryAttempts = 0;
        if (AnalyticsModule) AnalyticsModule.trackStarted();
      });

      elements.video.addEventListener('pause', () => {
        state.isPlaying = false;
        UIModule.updatePlayButton(false);
        WatermarkModule.setPaused(true);
        if (AnalyticsModule) AnalyticsModule.onPause();
      });

      // 'play' depois de 'playing' inicial ⇒ retomada após pause.
      elements.video.addEventListener('play', () => {
        state.isPlaying = true;
        UIModule.updatePlayButton(true);
        WatermarkModule.setPaused(false);
        if (AnalyticsModule) AnalyticsModule.onResume();
      });

      elements.video.addEventListener('ended', () => {
        if (AnalyticsModule) AnalyticsModule.onEnded();
      });

      elements.video.addEventListener('stalled', () => {
        if (state.hls) {
          const bufferLen = getBufferLength();
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
    StallMonitor.stop();
    WatermarkModule.stop();
    EPGModule.destroy();

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

  // Fechar/carregar outra página no iframe ⇒ abortar sessão com 'stop'
  // (keepalive garante a entrega mesmo no teardown da página).
  window.addEventListener('pagehide', () => {
    if (AnalyticsModule) AnalyticsModule.onStop();
  });

})();
