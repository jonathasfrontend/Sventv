const axios = require('axios');

const config = require('../config/app');
const M3UService = require('./m3uService');
const channelHealthRepository = require('../repositories/channelHealthRepository');
const alertService = require('./alertService');
const { inc } = require('../utils/metrics');

/**
 * SvenTV API - ChannelHealthService
 *
 * Verifica a disponibilidade dos canais e gerencia FAILOVER AUTOMÁTICO entre
 * fontes (primaryUrl -> backupUrl, agregadas pelo M3UService).
 *
 * Limitações arquiteturais (serverless):
 * - O estado de health (ok/failCount por fonte) é mantido EM MEMÓRIA (Map),
 *   como rate limiters e StreamLimiter. Na Vercel, cada instância lambda fria
 *   recomeça checks; a camada de segurança do proxy (SSRF guard) nunca depende
 *   deste serviço.
 * - Persistência (channel_health, CHANNEL_HEALTH_PERSIST_ENABLED): apenas o
 *   ACTIVE SOURCE da ÚLTIMA TRANSIÇÃO é gravado (precisa sobreviver a cold
 *   start). Cada check normal faz ZERO escritas; só TROCAS de fonte geram um
 *   upsert. No cold start, ensureLoaded() restaura o activeSource (anulando
 *   counts em memória — a tabela não guarda contadores vivos).
 * - Anti-flapping: só há troca de fonte após `failoverThreshold` falhas
 *   consecutivas e respeitando `minSwitchMs` entre trocas.
 * - Failback: a primária voltando a responder e o backup falhando — ou após
 *   `failbackMinMs` — faz o canal retornar para a fonte primária.
 * - Alertas: cada transição (failover/failback) dispara alertService.notify
 *   (fire-and-forget, com debounce) — nunca bloqueia o ciclo de checagem.
 *
 * Singleton: `getShared()` (mesmo padrão de M3UService/ChannelStateService).
 */
class ChannelHealthService {
  constructor(m3uService = null, options = {}) {
    this.m3uService = m3uService || null;
    this.statuses = new Map(); // id -> entry (ver _newEntry)
    this.intervalMs = options.intervalMs || 60 * 1000; // 1 minuto por padrão
    this.requestTimeout = options.requestTimeout || 8000; // ms
    this.failoverThreshold = options.failoverThreshold ?? 2;
    this.failbackMinMs = options.failbackMinMs ?? this.intervalMs * 2;
    this.minSwitchMs = options.minSwitchMs ?? this.intervalMs;

    // Persistência do active source (0 escritas sem transição):
    // disponível via opção (testes injetam persistEnabled/repository/clock).
    this.persistEnabled = Boolean(
      options.persistEnabled !== undefined
        ? options.persistEnabled
        : config.health.persistEnabled
    );
    this.repository = options.repository || channelHealthRepository;
    this.now = options.now || (() => Date.now());
    this._loadedHealth = null;

    if (this.m3uService) {
      this.startAutoChecks();
    }
  }

  attachM3UService(service) {
    this.m3uService = service;
    if (!this._interval && this.m3uService) this.startAutoChecks();
  }

  startAutoChecks() {
    if (this._interval) return;
    this._interval = setInterval(() => this.checkAllChannels().catch(() => {}), this.intervalMs);
    // run immediately once
    this.checkAllChannels().catch(() => {});
  }

  stopAutoChecks() {
    if (this._interval) clearInterval(this._interval);
    this._interval = null;
  }

  /**
   * Sessão de status de um canal.
   * @returns {{ activeSource: 'primary'|'backup', lastSwitchAt: number,
   *   primary: {ok:boolean|null, checkedAt:string|null, failCount:number},
   *   backup: {ok:boolean|null, checkedAt:string|null, failCount:number}|null }}
   */
  _newEntry(channel) {
    const entry = {
      activeSource: 'primary',
      lastSwitchAt: 0,
      primary: { ok: null, checkedAt: null, failCount: 0 },
      backup: null,
    };
    if (channel && (channel.backupUrl || (channel.urls || []).length > 1)) {
      entry.backup = { ok: null, checkedAt: null, failCount: 0 };
    }
    return entry;
  }

  /**
   * Lista fontes conhecidas de um canal: [{key, url}, ...].
   * primaryUrl/url primeiro, backupUrl depois (se distinta).
   */
  _sources(channel) {
    const primary = channel.url || channel.primaryUrl || (channel.urls && channel.urls[0]) || null;
    const backup = channel.backupUrl || null;
    const sources = [{ key: 'primary', url: primary }];
    if (backup && backup !== primary) sources.push({ key: 'backup', url: backup });
    return sources.filter(s => s.url);
  }

  /**
   * Faz o request de verificação de uma URL (sem efeito colateral no status).
   * @returns {Promise<boolean>}
   */
  async _checkUrl(url) {
    if (!url) return false;
    try {
      const res = await axios.request({
        method: 'get',
        url,
        responseType: 'stream',
        timeout: this.requestTimeout,
        headers: {
          // Try to fetch a small range to avoid downloading large streams
          Range: 'bytes=0-65535',
          'User-Agent': 'SvenTV-HealthChecker/1.0'
        },
        maxRedirects: 3,
        validateStatus: status => status >= 200 && status < 400
      });

      const contentType = (res.headers['content-type'] || '').toLowerCase();
      // Consider success if response is OK and content-type hints a media/playlist
      const ok = (contentType.includes('mpegurl') || contentType.includes('application') || contentType.includes('video') || contentType.includes('audio') || contentType.includes('text'))
        || (res.status === 200 || res.status === 206);

      // Ensure stream is destroyed to free socket
      try { res.data.destroy(); } catch (e) {}

      return ok;
    } catch (err) {
      return false;
    }
  }

  /**
   * Avalia failover/failback com anti-flapping.
   * Só atua quando o canal possui mais de uma fonte. Em TRANSIÇÃO real (a
   * fonte ativa muda) dispara: persistência (0 escritas sem transição),
   * alerta operacional e métrica. Tudo best-effort — nunca lança.
   */
  async _maybeSwitch(channel, entry) {
    if (!entry || !entry.backup) return;
    const now = this.now();
    const cur = entry.activeSource;
    let next = null;

    if (cur === 'primary') {
      const primary = entry.primary;
      const backup = entry.backup;
      if (
        primary && primary.failCount >= this.failoverThreshold &&
        backup && backup.ok === true &&
        this._canSwitch(now, entry)
      ) {
        next = 'backup';
      }
    } else {
      // ativo = backup → tenta voltar para a primária
      const primary = entry.primary;
      const backup = entry.backup;
      const primaryRevived = primary && primary.ok === true;
      if (primaryRevived && this._canSwitch(now, entry)) {
        if ((backup && backup.failCount > 0) || (entry.lastSwitchAt + this.failbackMinMs < now)) {
          next = 'primary';
        }
      }
    }

    if (next && next !== cur) {
      const prev = cur;
      entry.activeSource = next;
      entry.lastSwitchAt = now;
      this._afterSwitch(channel, entry, prev);
      await this._persistSwitch(channel, entry, prev);
    }
  }

  _canSwitch(now, entry) {
    return !entry.lastSwitchAt || (now - entry.lastSwitchAt) >= this.minSwitchMs;
  }

  /**
   * Efeitos colaterais da transição (alerta + métrica). Fire-and-forget:
   * nunca lança nem bloqueia o ciclo.
   */
  _afterSwitch(channel, entry, prev) {
    const detail = { channelId: channel && channel.id, channelName: channel && channel.name };
    if (prev === 'primary' && entry.activeSource === 'backup') {
      alertService.notify('channelHealth.failover', detail);
    } else if (prev === 'backup' && entry.activeSource === 'primary') {
      alertService.notify('channelHealth.failback', detail);
    }
  }

  /**
   * Write-through do active source após TRANSIÇÃO. NUNCA chamado em checks
   * sem troca. Fail-open: falha de banco é logada/contada, não derruba nada.
   */
  async _persistSwitch(channel, entry, prev) {
    if (!this.persistEnabled || !channel || !channel.id) return;
    const active = entry.activeSource;
    const failsEntry = entry[active];
    const fails = failsEntry && typeof failsEntry.failCount === 'number' ? failsEntry.failCount : 0;
    try {
      await this.repository.upsertHealth(channel.id, {
        activeSource: active,
        consecutiveFails: fails,
        lastSwitchAt: entry.lastSwitchAt ? new Date(entry.lastSwitchAt) : null,
      });
    } catch (error) {
      inc('channelHealthPersistenceFailures');
      console.error(`Falha ao persistir failover do canal ${channel.id}:`, error && error.message);
    }
  }

  /**
   * Checa TODAS as fontes do canal e reavalia failover.
   * @param {Object} channel - Canal do M3UService
   */
  async checkChannel(channel) {
    let entry = this.statuses.get(channel.id);
    if (!entry) {
      entry = this._newEntry(channel);
      this.statuses.set(channel.id, entry);
    }
    // Reload com nova fonte adicionada? Garante a sessão do backup.
    if (this._sources(channel).some(s => s.key === 'backup') && !entry.backup) {
      entry.backup = { ok: null, checkedAt: null, failCount: 0 };
    }

    const sources = this._sources(channel);
    for (const src of sources) {
      const ok = await this._checkUrl(src.url);
      const cur = entry[src.key] || { ok: null, checkedAt: null, failCount: 0 };
      cur.ok = ok;
      cur.checkedAt = new Date().toISOString();
      cur.failCount = ok ? 0 : (cur.failCount || 0) + 1;
      entry[src.key] = cur;
    }

    if (sources.length > 1) {
      await this._maybeSwitch(channel, entry);
    }
    return entry;
  }

  async checkAllChannels() {
    if (!this.m3uService) return;
    const channels = this.m3uService.getAllChannels();
    // check in parallel but limit concurrency modestly
    const mapping = channels.map(ch => this.checkChannel(ch).catch(() => {}));
    await Promise.all(mapping);
  }

  /**
   * Hidrata o active source persistido (cold start). Idempotente e
   * tolerante a falhas (nunca rejeita). Uma query só.
   * @returns {Promise<number>} quantidade de canais com failover restaurado
   */
  async ensureLoaded() {
    if (this._loadedHealth) return this._loadedHealth;
    if (!this.persistEnabled) {
      this._loadedHealth = Promise.resolve(0);
      return this._loadedHealth;
    }
    this._loadedHealth = this.repository
      .loadAll()
      .then((rows) => {
        let count = 0;
        for (const row of rows || []) {
          if (!row || !row.channelId) continue;
          if (row.activeSource !== 'primary' && row.activeSource !== 'backup') continue;
          let entry = this.statuses.get(row.channelId);
          if (!entry) {
            const chann = this.m3uService ? this.m3uService.getChannelById(row.channelId) : null;
            entry = this._newEntry(chann);
            this.statuses.set(row.channelId, entry);
          }
          // Apenas o source ativo é restaurado. failCount fica em memória
          // (0) — a tabela não guarda contadores vivos (snapshot informativo).
          entry.activeSource = row.activeSource;
          if (row.lastSwitchAt) entry.lastSwitchAt = new Date(row.lastSwitchAt).getTime();
          count += 1;
        }
        return count;
      })
      .catch((error) => {
        console.error('Falha ao carregar failover de canais:', error && error.message);
        inc('channelHealthPersistenceFailures');
        return 0;
      });
    return this._loadedHealth;
  }

  /**
   * Retorno HTTP-friendly do status ativo (compatível com usos anteriores).
   * @returns {{ok: boolean, checkedAt: string, activeSource: string, primary: Object, backup: Object|null}}
   */
  _summary(entry) {
    const active = entry.activeSource === 'backup' && entry.backup ? entry.backup : entry.primary;
    return {
      ok: Boolean(active.ok),
      checkedAt: active.checkedAt,
      activeSource: entry.activeSource,
      primary: entry.primary,
      backup: entry.backup,
    };
  }

  async checkChannelById(id) {
    if (!this.m3uService) return { ok: false, checkedAt: null, activeSource: 'primary', primary: null, backup: null };
    const channel = this.m3uService.getChannelById(id);
    if (!channel) return { ok: false, checkedAt: null, activeSource: 'primary', primary: null, backup: null };
    const entry = await this.checkChannel(channel);
    return this._summary(entry);
  }

  async checkChannelByUrl(id, url) {
    // Legado: checa apenas uma URL e registra como fonte primária.
    let entry = this.statuses.get(id);
    if (!entry) {
      entry = this._newEntry(null);
      this.statuses.set(id, entry);
    }
    const ok = await this._checkUrl(url);
    entry.primary = { ok, checkedAt: new Date().toISOString(), failCount: ok ? 0 : (entry.primary.failCount || 0) + 1 };
    if (ok) entry.activeSource = 'primary';
    return entry.primary;
  }

  /**
   * URL ativa (respeitando o failover automático).
   * @returns {string|null}
   */
  resolveActiveUrl(channel) {
    const entry = this.statuses.get(channel.id);
    const active = entry ? entry.activeSource : 'primary';
    if (active === 'backup' && channel.backupUrl) return channel.backupUrl;
    return channel.url || channel.primaryUrl || (channel.urls && channel.urls[0]) || null;
  }

  /**
   * URLs ordenadas por preferência para tentativa no proxy:
   * [ativa, alternativa]. Nunca expor ao cliente.
   * @returns {string[]}
   */
  resolveSourceUrls(channel) {
    const sources = this._sources(channel).map(s => s.url);
    const active = this.resolveActiveUrl(channel);
    if (sources.length < 2) return sources;
    const first = sources[0];
    const second = sources[1];
    if (!active) return sources;
    if (active === second) return [second, first];
    return [first, second];
  }

  /**
   * Registra o resultado de uma requisição do proxy (observabilidade rápida,
   * sem disparar troca de fonte — quem decide é o ciclo automático).
   */
  reportResult(channelId, url, ok) {
    const channel = this.m3uService && this.m3uService.getChannelById(channelId);
    if (!channel || !url) return;
    let entry = this.statuses.get(channelId);
    if (!entry) {
      entry = this._newEntry(channel);
      this.statuses.set(channelId, entry);
    }
    const { key } = this._sources(channel).find(s => s.url === url) || { key: null };
    if (!key) return;
    const cur = entry[key] || { ok: null, checkedAt: null, failCount: 0 };
    entry[key] = {
      ok: Boolean(ok),
      checkedAt: new Date().toISOString(),
      failCount: ok ? 0 : (cur.failCount || 0) + 1,
    };
  }

  getStatuses() {
    const out = [];
    for (const [id, entry] of this.statuses.entries()) {
      out.push({ id, ...this._summary(entry) });
    }
    return out;
  }

  getFailoverInfo(id) {
    const entry = this.statuses.get(id);
    if (!entry) return null;
    return {
      id,
      activeSource: entry.activeSource,
      lastSwitchAt: entry.lastSwitchAt || null,
      fails: {
        primary: entry.primary.failCount,
        backup: entry.backup ? entry.backup.failCount : null,
      },
    };
  }
}

ChannelHealthService._shared = null;

/**
 * Instância única compartilhada entre controllers/app (1 ciclo de checks e
 * 1 cache de failover por lambda). Cria com o M3U compartilhado e os knobs
 * de config.health.
 * @returns {ChannelHealthService}
 */
ChannelHealthService.getShared = () => {
  if (!ChannelHealthService._shared) {
    ChannelHealthService._shared = new ChannelHealthService(M3UService.getShared(), {
      intervalMs: config.health.checkIntervalMs,
      requestTimeout: config.health.requestTimeoutMs,
      failoverThreshold: config.health.failoverThreshold,
      failbackMinMs: config.health.failbackMinMs,
    });
  }
  return ChannelHealthService._shared;
};

module.exports = ChannelHealthService;