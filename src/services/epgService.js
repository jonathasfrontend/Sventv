'use strict';
const axios = require('axios');
const { XMLParser } = require('fast-xml-parser');
const config = require('../config/app');
const M3UService = require('./m3uService');
const epgAliases = require('../config/epgAliases');
const logger = require('../utils/logger');
const { normalizeForSearch, splitTimeToken, matchesTimeToken } = require('../utils/searchNormalize');

const DEFAULT_MAX_XML_BYTES = 150 * 1024 * 1024;

/**
 * Serviço de EPG (Guia de Programação) — XMLTV em memória, tolerante a
 * serverless.
 *
 * Princípios operacionais (ver AGENTS.md):
 *  - Canais NÃO vêm desta fonte; o EPG só existe para quem JÁ existe na M3U.
 *  - `EPG_URL` é segredo operacional e NUNCA é logada nem exposta em resposta
 *    (qualquer mensagem de erro omite a URL e até o host).
 *  - Falha de fetch/parse é FAIL-OPEN: mantém o cache anterior e nunca lança
 *    para cima (a aplicação não derruba e o cliente nunca vê 500 por causa
 *    do EPG).
 *  - Casamento EPG↔canal é EXCLUSIVAMENTE por nome normalizado + epgAliases
 *    (nunca pelo id do <channel> do XMLTV), porque o channelId interno é o
 *    sha1 determinístico derivado do nome da M3U.
 *  - `EPG_ENABLED=false` desliga tudo (rotas vazias / página sem link), sem
 *    novo deploy.
 *
 * Singleton via `EPGService.getShared()` (mesmo padrão de m3uService e
 * channelStateService): cada instância lambda tem seu próprio cache.
 */
class EPGService {
  constructor({ m3uService = null } = {}) {
    this.m3uService = m3uService || M3UService.getShared();

    this.epgUrl = config.epg.url;
    this.enabled = Boolean(config.epg.enabled);
    this.cacheTtlMs = Number(config.epg.cacheTtlMs) || 1_800_000;
    this.fetchTimeoutMs = Number(config.epg.fetchTimeoutMs) || 10_000;

    // Estado em memória
    this.channels = [];              // [{ id, displayName }]
    this.programmes = [];            // programmes normalizados (sorted)
    this.programmesByChannel = new Map(); // epgChannelId -> programmes[]
    this.matchMap = new Map();       // internalChannelId -> epgChannelId
    this.matchEntries = [];          // [{ channelId, epgChannelId, displayName }]
    this.lastFetchedAt = 0;
    this.lastError = null;           // { type, message } SEM informações de URL/host
    this._fetchPromise = null;
  }

  static getShared(opts) {
    if (!EPGService._shared) EPGService._shared = new EPGService(opts || {});
    return EPGService._shared;
  }

  isEnabled() { return this.enabled; }
  hasData() { return this.channels.length > 0; }

  // ── Normalização de nomes ─────────────────────────────────────
  // Lowercase, remove acentos, remove parênteses/colchetes, remove sufixos
  // de qualidade (HD/FHD/4K/SD...), troca & por "e" e colapsa espaços.
  normalizeName(name) {
    return String(name || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s*\([^)]*\)/g, ' ')
      .replace(/\s*\[[^\]]*\]/g, ' ')
      .replace(/\b(?:8k|4k|uhd|fhd|hd|sd|hdr10|hdr|h265|hevc|h264)\b/g, ' ')
      .replace(/&/g, ' e ')
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // ── Parse de tempo XMLTV ──────────────────────────────────────
  // Formato: YYYYMMDDHHMMSS +ZZZZ (offset em relação ao UTC).
  parseXmltvTime(str) {
    if (typeof str !== 'string') return null;
    const m = str.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-]\d{4})?$/);
    if (!m) return null;
    const [, y, mo, d, h, mi, s, offset] = m;
    const utc = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
    if (Number.isNaN(utc)) return null;
    let offsetMs = 0;
    if (offset) {
      const sign = offset[0] === '-' ? -1 : 1;
      offsetMs = sign * (Number(offset.slice(1, 3)) * 3600 + Number(offset.slice(3, 5)) * 60) * 1000;
    }
    return utc - offsetMs; // hora local = UTC + offset → subtrai para voltar ao UTC
  }

  // ── Parsing do XML ────────────────────────────────────────────
  // Conteúdo textual que vem junto de atributos vira `{ '#text': ... }`;
  // esta extração normaliza string | object | array para uma string limpa.
  _extractText(v) {
    if (Array.isArray(v)) {
      for (const item of v) {
        const s = this._extractText(item);
        if (s) return s;
      }
      return '';
    }
    if (v == null) return '';
    if (typeof v === 'string') return v.trim();
    if (typeof v === 'object') {
      const text = v['#text'];
      if (text != null) return String(text).trim();
      return '';
    }
    return '';
  }

  _extractStringArray(v) {
    if (v == null) return [];
    const arr = Array.isArray(v) ? v : [v];
    return arr
      .map((x) => this._extractText(x))
      .filter(Boolean);
  }

  parseXml(xml) {
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      parseTagValue: false,
      parseAttributeValue: false,
      trimValues: true,
    });
    const data = parser.parse(xml);
    const tv = (data && data.tv) || {};

    const channelsRaw = tv.channel ? (Array.isArray(tv.channel) ? tv.channel : [tv.channel]) : [];
    const channels = [];
    for (const c of channelsRaw) {
      const id = this._extractText(c && c['@_id'] || '');
      if (!id) continue;
      const displayName = this._extractText(c && (c['display-name'] || c.displayName));
      channels.push({ id, displayName });
    }

    const programmesRaw = tv.programme ? (Array.isArray(tv.programme) ? tv.programme : [tv.programme]) : [];
    const programmes = [];
    for (const p of programmesRaw) {
      const epgChannelId = this._extractText(p && p['@_channel']);
      const start = this.parseXmltvTime(p && p['@_start']);
      const stop = this.parseXmltvTime(p && p['@_stop']);
      if (!epgChannelId || start == null || stop == null) continue;
      const title = this._extractText(p && (p['title'] || p.title));
      if (!title) continue;
      programmes.push({
        channel: epgChannelId,
        start,
        stop,
        title,
        subtitle: this._extractText(p && (p['sub-title'] || p.subtitle)),
        description: this._extractText(p && (p['desc'] || p.description)),
        categories: this._extractStringArray(p && (p['category'] || p.category)),
      });
    }

    return { channels, programmes };
  }

  // ── Fetch + commit (fail-open) ────────────────────────────────
  // A chamada de rede fica isolada em `_fetchXml` para permitir stubbing
  // em teste sem tocar no resto do fluxo.
  async _fetchXml() {
    const response = await axios.get(this.epgUrl, {
      timeout: this.fetchTimeoutMs,
      maxContentLength: DEFAULT_MAX_XML_BYTES,
      responseType: 'text',
      headers: { 'Accept-Encoding': 'gzip, deflate' },
    });
    return response.data;
  }

  async fetchAndParse() {
    if (!this.enabled || !this.epgUrl) {
      return { enabled: this.enabled && Boolean(this.epgUrl), cached: this.hasData() };
    }
    try {
      const data = await this._fetchXml();
      const parsed = this.parseXml(data);

      // Commit do cache inteiro de uma vez (só substitui em caso de sucesso).
      this.channels = parsed.channels;
      this.programmes = parsed.programmes;
      this.programmesByChannel = this._groupByChannel(parsed.programmes);
      this.lastFetchedAt = Date.now();
      this.lastError = null;
      this._rebuildMatching();

      logger.info(`[epgService] XML processado: ${parsed.channels.length} canais, ${parsed.programmes.length} programas EPG`);
      return {
        enabled: true,
        channels: parsed.channels.length,
        programmes: parsed.programmes.length,
        cached: true,
      };
    } catch (err) {
      // FAIL-OPEN: mantém o cache anterior. Nunca loga URL/host/segredo.
      const type = this._safeErrorType(err);
      const message = this._safeErrorMessage(type);
      this.lastError = { type, message };
      if (!this.hasData()) {
        logger.warn('[epgService] falha ao buscar XML EPG (sem cache anterior) — EPG indisponível temporariamente');
      } else {
        logger.warn('[epgService] falha ao renovar XML EPG — mantendo cache anterior');
      }
      return { enabled: true, error: type, cached: this.hasData() };
    }
  }

  _safeErrorType(err) {
    const code = (err && err.code) || '';
    if (code === 'SSRF_BLOCKED') return 'SSRF_BLOCKED';
    if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') return 'TIMEOUT';
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'DNS';
    if (code === 'ECONNREFUSED' || code === 'ENETUNREACH' || code === 'EHOSTUNREACH') return 'CONNECTION';
    // Sempre esconde a URL/host da mensagem (segurança: EPG_URL é segredo).
    return 'HTTP';
  }

  _safeErrorMessage(type) {
    // Nunca inclui URL, host ou detalhe da requisição.
    if (type === 'SSRF_BLOCKED') return 'Falha de fetching EPG bloqueada por segurança (target restrito)';
    if (type === 'TIMEOUT') return 'Tempo de resposta excedido';
    if (type === 'DNS') return 'Não foi possível encontrar o servidor do provedor';
    if (type === 'CONNECTION') return 'Falha de conexão com o provedor';
    return 'Falha ao obter o XML do provedor';
  }

  // ── Cold start tolerance ──────────────────────────────────────
  // Garante que exista um fetch em andamento quando o cache está vazio ou
  // expirado, e devolve a promise do fetch corrente (nunca rejeitada).
  ensureLoaded() {
    if (!this.enabled || !this.epgUrl) return Promise.resolve(this);
    this._maybeRefresh();
    return this._fetchPromise || Promise.resolve(this);
  }

  _maybeRefresh() {
    const now = Date.now();
    const stale = !this.hasData() || now - this.lastFetchedAt >= this.cacheTtlMs;
    if (!stale) return;
    if (this._fetchPromise) return;
    this._fetchPromise = this.fetchAndParse().finally(() => {
      this._fetchPromise = null;
    });
  }

  // ── Matching ──────────────────────────────────────────────────
  buildNameIndex(m3uChannels) {
    const index = new Map();
    for (const ch of m3uChannels || []) {
      const normalized = this.normalizeName(ch.cleanName || ch.name || '');
      if (!normalized) continue;
      // Primeira ocorrência vence.
      if (!index.has(normalized)) index.set(normalized, ch.id);
    }
    return index;
  }

  // Casam por nome DIRETO primeiro; em seguida via epgAliases[epgChannelId].
  // Canais sem match são descartados (nunca aparecem na guia).
  matchEpgChannels(epgChannels, nameIndex, aliasMap = {}) {
    const matchMap = new Map();
    const usedInternal = new Set();

    for (const epg of epgChannels || []) {
      const displayName = epg.displayName || '';
      const normalized = this.normalizeName(displayName);
      let internalId = normalized ? nameIndex.get(normalized) : null;

      if (!internalId && aliasMap[epg.id]) {
        const aliasNorm = this.normalizeName(aliasMap[epg.id]);
        internalId = aliasNorm ? nameIndex.get(aliasNorm) : null;
      }

      if (!internalId || usedInternal.has(internalId)) continue;
      usedInternal.add(internalId);
      matchMap.set(internalId, epg.id);
    }

    return matchMap;
  }

  _rebuildMatching() {
    const m3uChannels = this.m3uService.getAllChannels ? this.m3uService.getAllChannels() : [];
    const nameIndex = this.buildNameIndex(m3uChannels);
    this.matchMap = this.matchEpgChannels(this.channels, nameIndex, epgAliases);

    this.matchEntries = [];
    const displayN = new Map();
    for (const epg of this.channels) {
      displayN.set(epg.id, epg.displayName);
    }
    for (const [channelId, epgChannelId] of this.matchMap.entries()) {
      this.matchEntries.push({
        channelId,
        epgChannelId,
        displayName: displayN.get(epgChannelId) || '',
      });
    }
  }

  // Recalcula matching após reload das M3U (os IDs de canal mudam pouco,
  // mas nomes podem vir com sufixos novos).
  rebuildMatching() {
    this._rebuildMatching();
    return this;
  }

  getEpgChannelId(channelId) {
    return this.matchMap.get(channelId) || null;
  }

  getAllMatched() {
    return this.matchEntries.slice().sort((a, b) =>
      (a.displayName || '').localeCompare(b.displayName || 'pt-BR')
    );
  }

  // ── Guia ──────────────────────────────────────────────────────
  getGuide(channelId) {
    const epgChannelId = this.getEpgChannelId(channelId);
    if (!epgChannelId) return null;
    const list = this.programmesByChannel.get(epgChannelId) || [];
    return list.slice();
  }

  // now (em ms) injetável para teste. Retorna { current, next } ou null
  // quando o canal não tem match.
  getNowNext(channelId, now = Date.now()) {
    const epgChannelId = this.getEpgChannelId(channelId);
    if (!epgChannelId) return null;
    const progs = (this.programmesByChannel.get(epgChannelId) || [])
      .slice()
      .sort((a, b) => (a.start - b.start) || (a.stop - b.stop));

    let current = null;
    for (const p of progs) {
      if (p.start <= now && now < p.stop) { current = p; break; }
    }

    let next = null;
    for (const p of progs) {
      if (p.start >= now && p !== current) { next = p; break; }
    }

    return { current, next };
  }

  // ── Janela do player (embutida no HTML) ───────────────────────
  // Devolve, para UM canal, os programas que intersectam a janela
  // [from, to] com os horários ORIGINAIS do XMLTV (sem recorte: o player
  // calcula o progresso do programa atual com base no início real). Sem
  // fetch — trabalha sobre o cache atual (fail-open fica no chamador).
  // Ordenado por start ASC para busca local eficiente de atual/próximo.
  // Nunca vaza EPG_URL nem qualquer dado interno.
  getPlayerWindow(channelId, from, to) {
    const epgChannelId = this.getEpgChannelId(channelId);
    if (!epgChannelId) return [];
    const fromMs = Number(from);
    const toMs = Number(to);
    const out = [];
    for (const p of (this.programmesByChannel.get(epgChannelId) || [])) {
      if (p.stop <= fromMs || p.start >= toMs) continue;
      out.push({
        start: p.start,
        stop: p.stop,
        title: p.title,
        subtitle: p.subtitle || '',
        description: p.description || '',
      });
    }
    out.sort((a, b) => (a.start - b.start) || (a.stop - b.stop));
    return out;
  }

  // ── Grid (grade por janela) ───────────────────────────────────
  // Devolve, para TODOS os canais da M3U, os programas que intersectam a
  // janela [from, to] — recortados aos limites da janela (start/stop já
  // no intervalo) e com `isLive` calculado sobre os horários ORIGINAIS do
  // XMLTV (um programa que começou antes de "from" e está no ar agora
  // continua "ao vivo" mesmo com a célula recortada). Canais da M3U sem
  // match no XMLTV aparecem com `programmes: []` — a guia nunca esconde
  // canal da lista oficial; a ausência de programação é sinalizada pelo
  // frontend ("Sem programação no período"). Nunca vaza EPG_URL.
  getGrid(from, to, now = Date.now()) {
    const fromMs = Number(from);
    const toMs = Number(to);
    const nowMs = Number(now);

    const displayNames = new Map();
    for (const c of this.channels || []) displayNames.set(c.id, c.displayName);

    const m3uChannels = this.m3uService.getAllChannels ? this.m3uService.getAllChannels() : [];
    const channels = [];
    for (const m3u of m3uChannels) {
      const epgChannelId = this.matchMap.get(m3u.id) || null;
      const programmes = [];

      if (epgChannelId) {
        const full = (this.programmesByChannel.get(epgChannelId) || [])
          .slice()
          .sort((a, b) => (a.start - b.start) || (a.stop - b.stop));
        for (const p of full) {
          if (p.stop <= fromMs || p.start >= toMs) continue;
          const start = Math.max(p.start, fromMs);
          const stop = Math.min(p.stop, toMs);
          if (stop <= start) continue;
          programmes.push({
            title: p.title,
            subtitle: p.subtitle || '',
            description: p.description || '',
            categories: p.categories || [],
            start,
            stop,
            // "Ao vivo" olha os horários originais (programa contém `now`).
            isLive: p.start <= nowMs && nowMs < p.stop,
          });
        }
      }

      channels.push({
        channelId: m3u.id,
        epgChannelId,
        displayName: epgChannelId
          ? (displayNames.get(epgChannelId) || '')
          : (m3u.cleanName || m3u.name || ''),
        programmes,
      });
    }

    return { from: fromMs, to: toMs, now: nowMs, total: channels.length, channels };
  }

  // ── Busca combinada (canais + programação) ────────────────────
  // Busca em TODA a programação do EPG em memória (não apenas a janela do
  // grid). Semântica idêntica ao filtro client-side (public/js/guide-search.js):
  // texto sem acentos/caixa + token de horário ("20h", "20h30", "20:30")
  // resolvido no fuso fornecido por `tzOffsetMinutes` (o cliente envia o seu
  // offset; tests usam 0 = UTC). Canais são os da M3U oficial (a busca nunca
  // inventa canal); programas só existem quando há match EPG. Limites de
  // volume defensivos (50 canais / 100 programas por padrão).
  search(query, opts = {}) {
    const limitChannels = Math.min(100, Math.max(1, Number(opts.limitChannels) || 50));
    const limitProgrammes = Math.min(200, Math.max(1, Number(opts.limitProgrammes) || 100));
    const tzOffsetMinutes = Number(opts.tzOffsetMinutes) || 0;
    const { time, text } = splitTimeToken(query);

    const m3uChannels = this.m3uService.getAllChannels ? this.m3uService.getAllChannels() : [];

    const internalByEpg = new Map();
    for (const e of this.matchEntries) internalByEpg.set(e.epgChannelId, e.channelId);

    const channels = [];
    const matchedChannelIds = new Set();
    if (text) {
      for (const ch of m3uChannels) {
        const hay = normalizeForSearch([ch.cleanName, ch.name, ch.category].filter(Boolean).join(' '));
        if (!hay.includes(text)) continue;
        channels.push(ch);
        matchedChannelIds.add(ch.id);
        if (channels.length >= limitChannels) break;
      }
    }

    const programmes = [];
    for (const p of this.programmes) {
      const channelId = internalByEpg.get(p.channel);
      if (!channelId) continue; // canal sem match na M3U não participa
      // Canal já casou pelo nome → TODA a programação dele entra (filtro de
      // horário ainda vale); só programas de canais não casados são filtrados
      // pelo texto. É o que faz a busca de canal trazer a grade completa.
      const channelMatched = matchedChannelIds.has(channelId);
      if (text && !channelMatched) {
        const hay = normalizeForSearch([p.title, p.subtitle, p.description, ...(p.categories || [])].filter(Boolean).join(' '));
        if (!hay.includes(text)) continue;
      }
      if (!matchesTimeToken(p.start, time, tzOffsetMinutes)) continue;
      programmes.push({
        channelId,
        start: p.start,
        stop: p.stop,
        title: p.title,
        subtitle: p.subtitle || '',
        description: p.description || '',
        categories: p.categories || [],
      });
      if (programmes.length >= limitProgrammes) break;
    }

    programmes.sort((a, b) => (a.start - b.start) || (a.stop - b.stop));

    return { channels, programmes, matchedProgrammes: programmes.length };
  }

  // ── Relatório admin (sem segredos) ────────────────────────────
  getUnmatchedReport() {
    const matchedEpgIds = new Set(this.matchMap.values());
    const epgWithoutMatch = this.channels
      .filter((c) => !matchedEpgIds.has(c.id))
      .map((c) => ({ epgChannelId: c.id, displayName: c.displayName || '' }))
      .sort((a, b) => (a.displayName || '').localeCompare(b.displayName || 'pt-BR'));

    const m3uChannels = this.m3uService.getAllChannels ? this.m3uService.getAllChannels() : [];
    const m3uWithoutEpg = m3uChannels
      .filter((ch) => !this.matchMap.has(ch.id))
      .map((ch) => ({ channelId: ch.id, name: ch.cleanName || ch.name || '' }))
      .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));

    return {
      totalEpg: this.channels.length,
      totalM3u: m3uChannels.length,
      matched: this.matchMap.size,
      epgWithoutMatch,
      m3uWithoutEpg,
    };
  }

  _groupByChannel(programmes) {
    const map = new Map();
    for (const p of programmes) {
      const arr = map.get(p.channel);
      if (arr) arr.push(p);
      else map.set(p.channel, [p]);
    }
    return map;
  }

  // Para testes/observabilidade (sem segredos).
  getStats() {
    return {
      enabled: this.enabled,
      configured: Boolean(this.epgUrl),
      epgChannels: this.channels.length,
      programmes: this.programmes.length,
      matched: this.matchMap.size,
      lastFetchedAt: this.lastFetchedAt || null,
      lastError: this.lastError,
    };
  }
}

EPGService._shared = null;

module.exports = EPGService;