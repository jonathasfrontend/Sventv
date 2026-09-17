'use strict';
const axios = require('axios');
const config = require('../config/app');
const logger = require('../utils/logger');
const { assertSafeTarget } = require('./ssrfGuard');
const { inc, recordTrendingLatency } = require('../utils/metrics');

const DEFAULT_LIMIT = 10;

const LIVE_GENRES = [
  'Filme Ação',
  'Filme Comédia',
  'Filme Infantil',
  'Filme Aventura',
  'Filme Ficção',
  'Filme Romance',
  'Filme Suspense',
  'Filme Drama',
  'Infantil Programa',
  'Variedades Diversos',
  'Jornalismo Esportivo',
  'Jornalismo Informativo',
  'Séries Policial',
  'Documentário Diversos',
  'Esporte Futebol',
  'Infantil Desenho',
  'Infantil Diversos',
];

const MOVIE_QUERY = `
  {
    trecResults: recommendationsPopularity(period: 7, limit: 10, genres: [], type: "movies") {
      movies {
        id
        nowContentId
        title
        rating { description }
        runTime
        description { short }
        assets { ratio url category }
      }
    }
  }
`;

const SERIE_QUERY = `
  {
    recResults: recommendationsPopularity(period: 7, limit: 10, genres: [], type: "series") {
      series {
        id
        nowContentId
        title
        rating { description }
        runTime
        description { short }
        assets { ratio url category }
      }
    }
  }
`;

const channelQuery = (genres) => `
  {
    trecResults: LiveRecommendationsPopularityNearRealTime(limit: 10, genres: ${JSON.stringify(genres)}, channels: []) {
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
      position
      totalCount
    }
  }
`;

/**
 * Serviço de Tendências (Top 10) — catálogo externo de metadados em memória.
 *
 * Consulta um GraphQL do provedor de catálogo para alimentar os carrosséis
 * da dashboard: filmes/séries mais assistidos (period: 7) e programações ao
 * vivo em alta (LiveRecommendationsPopularityNearRealTime).
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

    // Cache em memória por seção (só substitui em caso de sucesso).
    this.sections = { movies: [], series: [], channels: [] };
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
    return Object.values(this.sections).some((list) => list.length > 0);
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

  async _fetchMovies() {
    const data = await this._postGraphQL({ query: MOVIE_QUERY });
    const raw = (data && data.data && data.data.trecResults && data.data.trecResults.movies) || [];
    return raw.map(normalizeItem(normalizeMovie)).filter(Boolean).slice(0, DEFAULT_LIMIT);
  }

  async _fetchSeries() {
    const data = await this._postGraphQL({ query: SERIE_QUERY });
    const raw = (data && data.data && data.data.recResults && data.data.recResults.series) || [];
    return raw.map(normalizeItem(normalizeSeries)).filter(Boolean).slice(0, DEFAULT_LIMIT);
  }

  async _fetchChannels() {
    const data = await this._postGraphQL({ query: channelQuery(LIVE_GENRES) });
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
    const [movies, series, channels] = await Promise.allSettled([
      this._fetchMovies(),
      this._fetchSeries(),
      this._fetchChannels(),
    ]);

    const results = { enabled: true, movies: 'empty', series: 'empty', channels: 'empty', cached: this.hasData() };
    const errors = [];

    const commit = (key, settled) => {
      if (settled.status === 'fulfilled') {
        this.sections[key] = settled.value;
        results[key] = 'ok';
      } else {
        inc('trendingFetchFailures');
        const type = this._safeErrorType(settled.reason);
        errors.push(type);
        results[key] = type;
      }
    };
    commit('movies', movies);
    commit('series', series);
    commit('channels', channels);

    // Enquanto ao menos uma seção teve sucesso, o cache é renovado; se todas
    // falharam, lastFetchedAt não avança e o TTL volta a expirar no próximo
    // get (evita hammer na origem com dados velhos).
    if (movies.status === 'fulfilled' || series.status === 'fulfilled' || channels.status === 'fulfilled') {
      this.lastFetchedAt = Date.now();
    }
    if (errors.length > 0) {
      this.lastError = { type: errors[0], message: this._safeErrorMessage(errors[0]) };
      if (this.hasData()) {
        logger.warn('[trendingService] falha parcial ao renovar tendências — mantendo cache anterior');
      } else {
        logger.warn('[trendingService] falha ao buscar tendências (sem cache anterior) — seções vazias temporariamente');
      }
    } else {
      this.lastError = null;
    }

    recordTrendingLatency(Date.now() - startedAt);
    return results;
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
  getMovies({ force } = {}) {
    if (force) return this.sections.movies;
    if (this.isStale()) void this.ensureLoaded();
    return this.sections.movies;
  }

  getSeries({ force } = {}) {
    if (force) return this.sections.series;
    if (this.isStale()) void this.ensureLoaded();
    return this.sections.series;
  }

  getChannels({ force } = {}) {
    if (force) return this.sections.channels;
    if (this.isStale()) void this.ensureLoaded();
    return this.sections.channels;
  }

  getSnapshot({ force } = {}) {
    const sections = {
      movies: this.getMovies({ force }),
      series: this.getSeries({ force }),
      channels: this.getChannels({ force }),
    };
    return {
      fetchedAt: this.lastFetchedAt ? new Date(this.lastFetchedAt).toISOString() : null,
      cached: this.hasData(),
      total: {
        movies: sections.movies.length,
        series: sections.series.length,
        channels: sections.channels.length,
      },
      ...sections,
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
      movies: this.sections.movies.length,
      series: this.sections.series.length,
      channels: this.sections.channels.length,
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

function normalizeMovie(item) {
  if (!item || !item.title) return null;
  const assets = Array.isArray(item.assets) ? item.assets : [];
  const best = pickAsset(assets);
  return {
    id: stringOr(item.id, ''),
    nowContentId: stringOr(item.nowContentId, undefined),
    title: stringOr(item.title, ''),
    rating: stringOr(item.rating && item.rating.description, ''),
    runTime: formatRuntime(item.runTime),
    description: stringOr(item.description && item.description.short, ''),
    image: best ? best.url : '',
    images: assets
      .map((a) => ({ ratio: stringOr(a.ratio, ''), url: stringOr(a.url, ''), category: stringOr(a.category, '') }))
      .filter((a) => a.url),
  };
}

function normalizeSeries(item) {
  if (!item || !item.title) return null;
  const assets = Array.isArray(item.assets) ? item.assets : [];
  const best = pickAsset(assets);
  return {
    id: stringOr(item.id, ''),
    nowContentId: stringOr(item.nowContentId, undefined),
    title: stringOr(item.title, ''),
    rating: stringOr(item.rating && item.rating.description, ''),
    runTime: formatRuntime(item.runTime),
    description: stringOr(item.description && item.description.short, ''),
    image: best ? best.url : '',
    images: assets
      .map((a) => ({ ratio: stringOr(a.ratio, ''), url: stringOr(a.url, ''), category: stringOr(a.category, '') }))
      .filter((a) => a.url),
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
    logo: stringOr(firstUrl(assets), ''),
  };
}

/**
 * Escolhe a melhor imagem de catálogo para o card:
 *  1. categoria/rácio de poster/portrait (2:3 / 3:4 / "poster")
 *  2. paisagem 16:9 ("16x9"/"wide"/"landscape")
 *  3. qualquer outra (primeira)
 */
function pickAsset(assets) {
  if (!Array.isArray(assets) || assets.length === 0) return null;
  const poster = assets.find((a) => /poster|portrait|[23]:[34]|2x3|3x4/i.test(`${a.category || ''} ${a.ratio || ''}`));
  if (poster) return poster;
  const wide = assets.find((a) => /16x9|16:9|wide|landscape|backdrop|feature/i.test(`${a.category || ''} ${a.ratio || ''}`));
  return wide || assets[0];
}

function firstUrl(assets) {
  if (!Array.isArray(assets)) return '';
  const first = assets.find((a) => a && a.url);
  return first ? first.url : '';
}

/**
 * Formata duração: aceita ISO 8601 (`PT2H11M`), minutos numéricos ou texto.
 * Devolve algo amigável ("2h 11min", "57min") ou '' quando vazio.
 */
function formatRuntime(runTime) {
  if (runTime == null || runTime === '') return '';
  const s = String(runTime).trim();
  const iso = s.match(/^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (iso) {
    const h = iso[2] ? parseInt(iso[2], 10) : 0;
    const m = iso[3] ? parseInt(iso[3], 10) : 0;
    if (h > 0) return `${h}h ${m}min`;
    return m > 0 ? `${m}min` : '';
  }
  const n = Number(s);
  if (Number.isFinite(n) && s !== '') {
    const total = Math.max(0, Math.round(n));
    if (total >= 60) return `${Math.floor(total / 60)}h ${total % 60}min`;
    return `${total}min`;
  }
  return s;
}

function stringOr(v, fallback) {
  if (v == null) return fallback;
  return String(v);
}

module.exports = TrendingService;