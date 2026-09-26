'use strict';
const axios = require('axios');
const config = require('../config/app');
const logger = require('../utils/logger');
const { assertSafeTarget } = require('./ssrfGuard');
const { inc, recordTrendingLatency } = require('../utils/metrics');

const DEFAULT_LIMIT = 20;

// Taxonomia de gêneros do CATÁLOGO AO VIVO do provedor. Cuidado: nomes como
// "Filme Ação" e "Séries Policial" são o gênero do canal ao vivo (o canal
// transmite aquele conteúdo), NÃO seções de filmes/séries do app — remover
// estas entradas esvazia a query.
const LIVE_GENRES = [
  'Filme Ação',
  'Filme Comédia',
  'Filme Infantil',
  'Filme Aventura',
  'Filme Ficção',
  'Filme Romance',
  'Filme Suspense',
  'Filme Drama',
  'Séries Policial',
];

  // Gerenos removidos do filtro ao vivo.
  // 'Infantil Programa',
  // 'Variedades Diversos',
  // 'Jornalismo Esportivo',
  // 'Jornalismo Informativo',
  // 'Documentário Diversos',
  // 'Esporte Futebol',
  // 'Infantil Desenho',
  // 'Infantil Diversos',

// Só "Ao vivo em alta" (programações mais assistidas agora). Cada liveCatalog
// traz a arte da programação em vários tamanhos: 4 paisagem (212x119 … 408x230)
// e 5 retrato (~2:3: 129x194 … 360x540). O tamanho vem no assetId
// (`…_epg212x119`) e no path da URL (`/images_epg/360_540/…`).
const CHANNELS_QUERY = `
  {
    trecResults: LiveRecommendationsPopularityNearRealTime(limit: ${DEFAULT_LIMIT}, genres: ${JSON.stringify(LIVE_GENRES)}, channels: []) {
      liveCatalogs {
        id
        name
        shortName
        description
        genreCategory
        channelName
        genre
        assets { url assetId }
      }
    }
  }
`;

/**
 * Serviço de Tendências — SOMENTE programações ao vivo em alta.
 *
 * Consulta um GraphQL do provedor de catálogo (LiveRecommendationsPopularityNearRealTime)
 * para alimentar o carrossel "Ao vivo em alta" da dashboard.
 *
 * Princípios (mesmos do EPG):
 *  - `TRENDING_API_URL` (por padrão a URL do provedor) NUNCA é logada nem
 *    exposta em resposta — erros são genéricos (HTTP/TIMEOUT/DNS/...).
 *  - Falha de fetch é FAIL-OPEN: mantém o cache anterior e nunca lança para
 *    cima (a aplicação não derruba; o cliente vê lista vazia, nunca 500).
 *  - Cache em memória com TTL (`TRENDING_CACHE_TTL_MS`) — por lambda.
 *  - `TRENDING_ENABLED=false` desliga tudo (rotas devolvem listas vazias).
 *  - Só conteúdos de metadados (imagens púbicas de catálogo): NUNCA há URL
 *    de stream/upstream da SvenTV aqui.
 */
class TrendingService {
  constructor() {
    this.apiUrl = config.trending.apiUrl;
    this.enabled = Boolean(config.trending.enabled);
    this.cacheTtlMs = Number(config.trending.cacheTtlMs) || 1_800_000;
    this.fetchTimeoutMs = Number(config.trending.fetchTimeoutMs) || 10_000;

    // Cache em memória (só substitui em caso de sucesso).
    this.channels = [];
    this.lastFetchedAt = 0;
    this.lastError = null; // { type, message } SEM URL/host de provedor
    this._fetchPromise = null;
  }

  static getShared() {
    if (!TrendingService._shared) TrendingService._shared = new TrendingService();
    return TrendingService._shared;
  }

  isEnabled() {
    return this.enabled;
  }

  hasData() {
    return this.channels.length > 0;
  }

  // ── Requisição GraphQL (isolada para stubbing em teste) ────
  async _postGraphQL(body) {
    // Guarda anti-SSRF (1 lookup por refresh — barato) antes de qualquer
    // saída: protege contra TRENDING_API_URL apontando para destino interno.
    await assertSafeTarget(this.apiUrl);
    const response = await axios.post(this.apiUrl, body, {
      timeout: this.fetchTimeoutMs,
      headers: { 'Content-Type': 'application/json' },
    });
    return response.data;
  }

  async _fetchChannels() {
    const data = await this._postGraphQL({ query: CHANNELS_QUERY });
    const raw = (data && data.data && data.data.trecResults && data.data.trecResults.liveCatalogs) || [];
    return raw.map(normalizeItem(normalizeChannel)).filter(Boolean).slice(0, DEFAULT_LIMIT);
  }

  // ── Refresh + commit (fail-open) ───────────────────────────
  async fetchAndParse() {
    if (!this.enabled) {
      return { enabled: false, cached: this.hasData() };
    }

    const startedAt = Date.now();
    inc('trendingFetches');

    let result = 'ok';
    try {
      this.channels = await this._fetchChannels();
    } catch (err) {
      inc('trendingFetchFailures');
      result = this._safeErrorType(err);
    }

    // Só renova o TTL quando houve sucesso: se falhou, lastFetchedAt não avança
    // e o TTL volta a expirar no próximo get (evita hammer na origem, mas
    // também permite recuperar rápido). O cache anterior permanece intacto.
    if (result === 'ok') {
      this.lastFetchedAt = Date.now();
      this.lastError = null;
    } else {
      this.lastError = { type: result, message: this._safeErrorMessage(result) };
      if (this.hasData()) {
        logger.warn('[trendingService] falha ao renovar tendencias ao vivo — mantendo cache anterior');
      } else {
        logger.warn('[trendingService] falha ao buscar tendencias ao vivo (sem cache anterior) — secao vazia temporariamente');
      }
    }

    recordTrendingLatency(Date.now() - startedAt);
    return { enabled: true, channels: result, cached: this.hasData() };
  }

  _safeErrorType(err) {
    const code = (err && err.code) || '';
    if (code === 'SSRF_BLOCKED' || code === 'DNS_FAILURE') return code;
    if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') return 'TIMEOUT';
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'DNS';
    if (code === 'ECONNREFUSED' || code === 'ENETUNREACH' || code === 'EHOSTUNREACH') return 'CONNECTION';
    if (code && String(code).startsWith('ECONN')) return 'CONNECTION';
    // Nunca expõe a URL/host do provedor em mensagem.
    return 'HTTP';
  }

  _safeErrorMessage(type) {
    if (type === 'SSRF_BLOCKED') return 'Falha de fetching de catálogo bloqueada por segurança (target restrito)';
    if (type === 'DNS_FAILURE') return 'Não foi possível resolver o servidor do catálogo';
    if (type === 'TIMEOUT') return 'Tempo de resposta excedido';
    if (type === 'DNS') return 'Não foi possível encontrar o servidor do provedor';
    if (type === 'CONNECTION') return 'Falha de conexão com o provedor';
    return 'Falha ao obter os metadados do provedor';
  }

  // ── Cold start tolerance ──────────────────────────────────
  // Garante que exista um fetch em andamento quando o cache está vazio ou
  // expirado e devolve a promise do fetch corrente (nunca rejeitada).
  ensureLoaded() {
    if (!this.enabled) return Promise.resolve(this);
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

  // ── Leitura ───────────────────────────────────────────────
  getChannels({ force } = {}) {
    if (force) return this.channels;
    if (this.isStale()) void this.ensureLoaded();
    return this.channels;
  }

  getSnapshot({ force } = {}) {
    const channels = this.getChannels({ force });
    return {
      fetchedAt: this.lastFetchedAt ? new Date(this.lastFetchedAt).toISOString() : null,
      cached: this.hasData(),
      total: { channels: channels.length },
      channels,
    };
  }

  isStale() {
    if (!this.enabled) return false;
    return !this.hasData() || (Date.now() - this.lastFetchedAt >= this.cacheTtlMs);
  }

  getStats() {
    return {
      enabled: this.enabled,
      configured: Boolean(this.apiUrl),
      channels: this.channels.length,
      lastFetchedAt: this.lastFetchedAt || null,
      lastError: this.lastError,
    };
  }
}

TrendingService._shared = null;

// ── Normalização (whitelist pública — sem URL de stream) ────

function normalizeItem(normalizer) {
  return (item) => {
    try {
      return normalizer(item);
    } catch (_) {
      return null;
    }
  };
}

function normalizeChannel(item) {
  if (!item || !item.id) return null;
  const assets = Array.isArray(item.assets) ? item.assets : [];
  return {
    id: stringOr(item.id, ''),
    name: stringOr(item.name, ''),
    shortName: stringOr(item.shortName, ''),
    description: stringOr(item.description, ''),
    genre: stringOr(item.genre, ''),
    genreCategory: stringOr(item.genreCategory, ''),
    channelName: stringOr(item.channelName, ''),
    // Arte da programação (pôster ~2:3). Ver `pickProgramImage`.
    image: pickProgramImage(assets),
  };
}

// O provedor devolve a MESMA arte em vários tamanhos. A ordem do array NÃO é
// garantida e a primeira entrada costuma ser a faixa paisagem (212x119),
// que num card vertical ficaria minúscula. Preferimos retrato ~2:3.
const TARGET_RATIO = 2 / 3;

function assetSize(asset) {
  if (!asset || typeof asset !== 'object') return null;
  // assetId: "0001546602_epg360x540"  |  url: ".../images_epg/360_540/....jpg"
  // O hint pode estar no fim da string, daí o `(?:[^\d]|$)`.
  const m =
    /(?:^|[^\d])(\d{2,4})x(\d{2,4})(?:[^\d]|$)/.exec(String(asset.assetId || '')) ||
    /\/(\d{2,4})_(\d{2,4})(?:[/.]|$)/.exec(String(asset.url || ''));
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (!w || !h) return null;
  return { w, h, ratio: w / h };
}

function pickProgramImage(assets) {
  const usable = (Array.isArray(assets) ? assets : []).filter((a) => a && a.url);
  if (usable.length === 0) return '';

  const sized = usable
    .map((a) => ({ asset: a, size: assetSize(a) }))
    .filter((x) => x.size);

  // Retrato primeiro (o card é vertical), depois o mais próximo de 2:3, e
  // entre equivalentes o maior (melhor nitidez sem exagero de banda).
  const portrait = sized.filter((x) => x.size.ratio < 1);
  const pool = portrait.length > 0 ? portrait : sized;
  if (pool.length > 0) {
    const best = pool.reduce((acc, x) => {
      if (!acc) return x;
      const dAcc = Math.abs(acc.size.ratio - TARGET_RATIO);
      const dNew = Math.abs(x.size.ratio - TARGET_RATIO);
      if (dAcc !== dNew) return dNew < dAcc ? x : acc;
      return x.size.w * x.size.h > acc.size.w * acc.size.h ? x : acc;
    }, null);
    return String(best.asset.url);
  }

  // Sem metadados de tamanho: primeiro asset com URL.
  return String(usable[0].url);
}

function stringOr(v, fallback) {
  if (v == null) return fallback;
  return String(v);
}

module.exports = TrendingService;
