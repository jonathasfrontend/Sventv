/**
 * SvenTV API - ChannelStateService
 *
 * Gerencia o ESTADO ADMINISTRATIVO dos canais:
 *   - live         → disponível para reprodução (padrão)
 *   - maintenance  → indisponível temporariamente (HTTPS 503 no proxy/player)
 *   - blocked      → bloqueado (HTTPS 403 no proxy/player)
 *
 * Arquitetura (ver config/app.js `channelState`): a fonte de verdade é o
 * PostgreSQL (tabela `channel_states`, via channelStateRepository) — o estado
 * sobrevive a restart/cold start e é GLOBAL entre instâncias serverless. Este
 * serviço mantém um cache local em memória com TTL curto
 * (CHANNEL_STATE_CACHE_TTL_MS, 8s padrão) e faz read-through no banco:
 *   - cache fresco  → resposta imediata (hit, sem IO);
 *   - cache expirado/ausente → consulta única ao banco (miss), atualiza cache;
 *   - banco indisponível  → FAIL-OPEN: mantém o valor em memória/`live` jamais
 *     derruba o gate (contadores `channelStateFallbacks`).
 * No cold start, ensureLoaded() hidrata o cache inteiro (uma query) antes de
 * servir — hot path e mutações não dependem de IIE por request.
 *
 * O estado é aplicado ANTES de qualquer acesso ao upstream, então não há risco
 * de SSRF/vazamento em canais bloqueados.
 */

'use strict';

const config = require('../config/app');
const { inc } = require('../utils/metrics');
const channelStateRepository = require('../repositories/channelStateRepository');

const VALID_STATES = ['live', 'maintenance', 'blocked'];

class ChannelStateService {
  /**
   * @param {Object} [opts]
   * @param {boolean} [opts.persistEnabled] kill switch p/ rodar 100% em memória
   * @param {Object} [opts.repository] injetar repositório (testes)
   * @param {number} [opts.cacheTtlMs] TTL do cache local
   * @param {() => number} [opts.now] relógio (testes)
   */
  constructor({
    persistEnabled = config.channelState.persistEnabled,
    repository = null,
    cacheTtlMs = config.channelState.cacheTtlMs,
    now = () => Date.now(),
  } = {}) {
    /** @type {Map<string, {state: string, reason: string, setBy: string|null, updatedAt: string}>} */
    this.states = new Map();
    /** @type {Map<string, number>} instante (ms) em que cada estado foi validado */
    this._fetchedAt = new Map();
    /** @type {Map<string, Promise>} refreshes em andamento (anti-thundering herd) */
    this._refreshing = new Map();
    this._persistEnabled = Boolean(persistEnabled);
    this._repository = repository || channelStateRepository;
    this._cacheTtlMs = Number(cacheTtlMs) > 0 ? Number(cacheTtlMs) : 0;
    this._now = now;
    this._loaded = null;
  }

  // ── Cache de leitura (helpers internos) ───────────────────────

  _fresh(id) {
    if (!this.states.has(id)) return false;
    const fetched = this._fetchedAt.get(id);
    if (typeof fetched !== 'number') return false;
    return this._now() - fetched < this._cacheTtlMs;
  }

  _markFetched(id) {
    this._fetchedAt.set(id, this._now());
  }

  _drop(id) {
    this.states.delete(id);
    this._fetchedAt.delete(id);
  }

  /**
   * Read-through com deduplicação de requisições concorrentes. Nunca lança:
   * retorna o entry em memória (ou null → live) diante de falha do banco.
   * @returns {Promise<{state: string, reason: string, setBy: string|null, updatedAt: string}|null>}
   */
  _refresh(id) {
    if (!this._persistEnabled) return Promise.resolve(null);
    if (this._refreshing.has(id)) return this._refreshing.get(id);

    const p = this._repository
      .getState(id)
      .then((row) => {
        if (row && row.channelId && VALID_STATES.includes(row.state)) {
          this.states.set(row.channelId, {
            state: row.state,
            reason: row.reason || '',
            setBy: row.setBy || null,
            updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : new Date(this._now()).toISOString(),
          });
          this._markFetched(row.channelId);
          return this.states.get(row.channelId);
        }
        this._drop(id); // sem registro no banco → estado padrão (live)
        return null;
      })
      .catch((error) => {
        // Fail-open: banco fora → mantém memória (ou live). Nunca throw.
        console.error('Falha ao consultar estado de canal:', error.message);
        inc('channelStateFallbacks');
        return this._fresh(id) ? this.states.get(id) : null;
      })
      .finally(() => {
        this._refreshing.delete(id);
      });

    this._refreshing.set(id, p);
    return p;
  }

  // ── API pública ──────────────────────────────────────────────

  /**
   * Estado do canal (async por causa do read-through). Cache curto em
   * memória; banco só quando expirado/ausente; fail-open em erro de banco.
   * @returns {Promise<'live'|'maintenance'|'blocked'>}
   */
  async get(id) {
    if (this._fresh(id)) {
      inc('channelStateCacheHits');
      return this.states.get(id).state;
    }
    inc('channelStateCacheMisses');
    const entry = await this._refresh(id);
    return entry ? entry.state : (this.states.has(id) ? this.states.get(id).state : 'live');
  }

  /**
   * Entry completo (reason/updatedAt/setBy) ou null quando o canal está no
   * estado padrão (live). Async pelo mesmo motivo do `get`.
   */
  async entry(id) {
    if (this._fresh(id)) {
      inc('channelStateCacheHits');
      return this.states.get(id);
    }
    inc('channelStateCacheMisses');
    const entry = await this._refresh(id);
    return entry || (this.states.has(id) ? this.states.get(id) : null);
  }

  async isPlayable(id) {
    return (await this.get(id)) === 'live';
  }

  /**
   * Leitura SÍNCRONA do cache em memória (sem banco, sem fail-over).
   * Destinada a espelhar o estado nos objetos M3U (`channel.state`) durante
   * a hidratação do cold start. O gating de reprodução NUNCA deve usar este
   * método — lá, eventual consistência conta (use `get`/`entry`, que
   * respeitam TTL/read-through/fail-open).
   */
  peek(id) {
    return this.states.has(id) ? this.states.get(id).state : 'live';
  }

  /**
   * Define o estado de um canal (APENAS memória/cache — a persistência no
   * banco é de responsabilidade do chamador admin via channelStateRepository,
   * mantendo `set` síncrono e testável em isolamento).
   * @param {string} id - ID do canal
   * @param {'live'|'maintenance'|'blocked'} state
   * @param {{reason?: string, actor?: string|null}} opts
   * @returns {{prevState: string, state: string, reason: string, updatedAt: string}}
   * @throws {Error} com .statusCode=422 e .code='VALIDATION' para estado inválido
   */
  set(id, state, { reason = '', actor = null } = {}) {
    if (!VALID_STATES.includes(state)) {
      const err = new Error('Estado inválido. Use "live", "maintenance" ou "blocked".');
      err.statusCode = 422;
      err.code = 'VALIDATION';
      throw err;
    }
    const prev = this.states.get(id);
    const entry = {
      state,
      reason: String(reason || '').trim().slice(0, 255),
      setBy: actor || null,
      updatedAt: new Date(this._now()).toISOString(),
    };
    this.states.set(id, entry);
    this._markFetched(id);
    return { prevState: prev ? prev.state : 'live', state: entry.state, reason: entry.reason, updatedAt: entry.updatedAt };
  }

  /**
   * Hidrata o cache local com todos os estados persistidos (cold start).
   * Idempotente e tolerante a falhas (nunca rejeita). Uma query só.
   * @returns {Promise<number>} quantidade de estados carregados
   */
  async ensureLoaded() {
    if (this._loaded) return this._loaded;
    if (!this._persistEnabled) {
      this._loaded = Promise.resolve(0);
      return this._loaded;
    }
    this._loaded = this._repository
      .loadAll()
      .then((rows) => {
        this.restore(rows);
        return Array.isArray(rows) ? rows.length : 0;
      })
      .catch((error) => {
        console.error('Falha ao carregar estados de canal:', error.message);
        inc('channelStateFallbacks');
        return 0;
      });
    return this._loaded;
  }

  /**
   * Substitui o cache com entradas vindas do banco (formato do repositório).
   * Útil também após reload de canais/limpeza de estados órfãos.
   * @param {Array<{channelId: string, state: string, reason: string, setBy: string|null, updatedAt: Date|string}>} rows
   */
  restore(rows) {
    if (!Array.isArray(rows)) return this;
    for (const row of rows) {
      if (!row || !row.channelId || !VALID_STATES.includes(row.state)) continue;
      this.states.set(row.channelId, {
        state: row.state,
        reason: row.reason || '',
        setBy: row.setBy ? String(row.setBy) : null,
        updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : new Date(this._now()).toISOString(),
      });
      this._markFetched(row.channelId);
    }
    return this;
  }

  /**
   * @returns {Array<{id: string, state: string, reason: string, setBy: string|null, updatedAt: string}>}
   */
  all() {
    const out = [];
    for (const [id, entry] of this.states.entries()) {
      out.push({ id, ...entry });
    }
    return out;
  }
}

ChannelStateService._shared = null;
ChannelStateService.getShared = () => {
  if (!ChannelStateService._shared) {
    ChannelStateService._shared = new ChannelStateService();
  }
  return ChannelStateService._shared;
};

module.exports = ChannelStateService;