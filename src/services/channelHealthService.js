const axios = require('axios');

class ChannelHealthService {
  constructor(m3uService = null, options = {}) {
    this.m3uService = m3uService || null;
    this.statuses = new Map(); // id -> { ok: boolean, checkedAt }
    this.intervalMs = options.intervalMs || 60 * 1000; // 1 minuto por padrão
    this.requestTimeout = options.requestTimeout || 8000; // ms

    // Start automatic checks if a service instance is provided
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

  async checkAllChannels() {
    if (!this.m3uService) return;
    const channels = this.m3uService.getAllChannels();
    // check in parallel but limit concurrency modestly
    const promises = channels.map(ch => this.checkChannelByUrl(ch.id, ch.url).catch(() => {}));
    await Promise.all(promises);
  }

  async checkChannelById(id) {
    if (!this.m3uService) return { ok: false };
    const channel = this.m3uService.getChannelById(id);
    if (!channel) return { ok: false };
    return this.checkChannelByUrl(id, channel.url);
  }

  async checkChannelByUrl(id, url) {
    const result = { ok: false, checkedAt: new Date().toISOString() };
    if (!url) {
      this.statuses.set(id, result);
      return result;
    }

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
      if (contentType.includes('mpegurl') || contentType.includes('application') || contentType.includes('video') || contentType.includes('audio') || contentType.includes('text')) {
        result.ok = true;
      } else if (res.status === 200 || res.status === 206) {
        result.ok = true;
      }

      // Ensure stream is destroyed to free socket
      try { res.data.destroy(); } catch (e) {}
    } catch (err) {
      result.ok = false;
    }

    result.checkedAt = new Date().toISOString();
    this.statuses.set(id, result);
    return result;
  }

  getStatuses() {
    const out = [];
    for (const [id, val] of this.statuses.entries()) {
      out.push({ id, ok: Boolean(val.ok), checkedAt: val.checkedAt });
    }
    return out;
  }
}

module.exports = ChannelHealthService;
