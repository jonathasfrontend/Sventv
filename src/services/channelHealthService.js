const axios = require('axios');

/**
 * SvenTV API - ChannelHealthService
 *
 * Verifica a disponibilidade dos canais e gerencia FAILOVER AUTOMÁTICO entre
 * fontes (primaryUrl -> backupUrl, agregadas pelo M3UService).
 *
 * Limitações arquiteturais (serverless):
 * - O estado de health é mantido EM MEMÓRIA (Map), como rate limiters e
 *   StreamLimiter. Na Vercel, cada instância lambda fria recomeça checks;
 *   a camada de segurança do proxy (SSRF guard) nunca depende deste serviço.
 * - Anti-flapping: só há troca de fonte após `failoverThreshold` falhas
 *   consecutivas e respeitando `minSwitchMs` entre trocas.
 * - Failback: a primária voltando a responder e o backup falhando — ou após
 *   `failbackMinMs` — faz o canal retornar para a fonte primária.
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
   * Só atua quando o canal possui mais de uma fonte.
   */
  _maybeSwitch(entry) {
    if (!entry.backup) return;
    const now = Date.now();
    const cur = entry.activeSource;

    if (cur === 'primary') {
      const primary = entry.primary;
      const backup = entry.backup;
      if (
        primary && primary.failCount >= this.failoverThreshold &&
        backup && backup.ok === true &&
        this._canSwitch(now, entry)
      ) {
        entry.activeSource = 'backup';
        entry.lastSwitchAt = now;
      }
      return;
    }

    // ativo = backup → tenta voltar para a primária
    const primary = entry.primary;
    const backup = entry.backup;
    const primaryRevived = primary && primary.ok === true;
    if (primaryRevived && this._canSwitch(now, entry)) {
      if ((backup && backup.failCount > 0) || (entry.lastSwitchAt + this.failbackMinMs < now)) {
        entry.activeSource = 'primary';
        entry.lastSwitchAt = now;
      }
    }
  }

  _canSwitch(now, entry) {
    return !entry.lastSwitchAt || (now - entry.lastSwitchAt) >= this.minSwitchMs;
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
      this._maybeSwitch(entry);
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

module.exports = ChannelHealthService;