/**
 * SvenTV API — IpBlocklistService (WAF / IP Access Control)
 *
 * Bloqueio administrativo POR IP, independente do estado de conta
 * (users.account_restricted). Fonte de verdade = Postgres (`ip_blocklist`,
 * via ipBlocklistRepository) — sobrevive a restart/cold start e é global
 * entre instâncias serverless. Este serviço mantém cache curto em memória
 * (IP_ACCESS_CACHE_TTL_MS, 10s padrão) com read-through no banco e
 * mutações write-through, espelhando o padrão arquitetural do
 * ChannelStateService:
 *   - cache fresco      → resposta imediata (hit, sem IO);
 *   - cache expirado/ausente → consulta única (miss) atualiza o cache;
 *   - banco indisponível → FAIL-OPEN: mantém o último estado em memória ou
 *     libera o acesso (a autenticação segue sendo a barreira primária —
 *     contadores `ipBlocklistFallbacks`).
 * No cold start, ensureLoaded() hidrata o cache inteiro (uma query).
 *
 * Decisões:
 *   - Bloqueio NUNCA derruba a própria persistência: aplicado em memória
 *     PRIMEIRO e persistido depois (se o banco falhar, fica em memória e é
 *     logado — mete `ipBlocklistPersistenceFailures`).
 *   - Desbloqueio falho no banco é tolerado com métrica: o TTL re-sincroniza
 *     com a fonte de verdade.
 *   - Kill switch IP_ACCESS_ENABLED=false desliga este serviço (retorna
 *     sempre liberado; o WAF_BLOCKED_IPS do env continua ativo).
 */

'use strict';

const config = require('../config/app');
const { normalizeIp } = require('../utils/ipAddress');
const { inc } = require('../utils/metrics');
const ipBlocklistRepository = require('../repositories/ipBlocklistRepository');

class IpBlocklistService {
  /**
   * @param {Object} [opts]
   * @param {boolean} [opts.enabled] kill switch p/ desligar a feature
   * @param {Object} [opts.repository] repositório injetável (testes)
   * @param {number} [opts.cacheTtlMs] TTL do cache local
   * @param {() => number} [opts.now] relógio (testes)
   */
  constructor({
    enabled = config.ipAccess.enabled,
    repository = null,
    cacheTtlMs = config.ipAccess.cacheTtlMs,
    now = () => Date.now(),
  } = {}) {
    /** @type {Map<string, {active: boolean, reason: string, blockedBy: string|null, blockedAt: string, updatedAt: string}>} */
    this._entries = new Map();
    /** @type {Map<string, number>} instante (ms) em que cada IP foi validado */
    this._fetchedAt = new Map();
    /** @type {Map<string, Promise>} refreshes em andamento (anti-thundering herd) */
    this._refreshing = new Map();
    this._enabled = Boolean(enabled);
    this._repository = repository || ipBlocklistRepository;
    this._cacheTtlMs = Number(cacheTtlMs) > 0 ? Number(cacheTtlMs) : 0;
    this._now = now;
    this._loaded = null;
  }

  // ── Cache de leitura (helpers internos) ───────────────────────

  _fresh(ip) {
    if (!this._entries.has(ip)) return false;
    const fetched = this._fetchedAt.get(ip);
    if (typeof fetched !== 'number') return false;
    return this._now() - fetched < this._cacheTtlMs;
  }

  _markFetched(ip) {
    this._fetchedAt.set(ip, this._now());
  }

  _drop(ip) {
    this._entries.delete(ip);
    this._fetchedAt.delete(ip);
  }

  /**
   * Read-through com deduplicação de requisições concorrentes. Nunca lança.
   * @returns {Promise<{active: boolean, reason: string, blockedBy: string|null, blockedAt: string}|null>}
   */
  _refresh(ip) {
    if (!this._enabled) return Promise.resolve(null);
    if (this._refreshing.has(ip)) return this._refreshing.get(ip);

    const p = this._repository
      .findActive(ip)
      .then((row) => {
        if (row && row.active) {
          this._entries.set(row.ip, {
            active: true,
            reason: row.reason || '',
            blockedBy: row.blockedBy || null,
            blockedAt: row.blockedAt ? new Date(row.blockedAt).toISOString() : new Date(this._now()).toISOString(),
          });
          this._markFetched(row.ip);
          return this._entries.get(row.ip);
        }
        this._drop(ip); // sem registro ativo → liberado
        return null;
      })
      .catch((error) => {
        // Fail-open: banco fora → mantém memória (ou liberado). Nunca throw.
        console.error('Falha ao consultar blocklist de IPs:', error.message);
        inc('ipBlocklistFallbacks');
        return this._fresh(ip) ? this._entries.get(ip) : null;
      })
      .finally(() => {
        this._refreshing.delete(ip);
      });

    this._refreshing.set(ip, p);
    return p;
  }

  // ── API pública ──────────────────────────────────────────────

  /**
   * O IP está ATIVAMENTE bloqueado? Async (read-through com cache curto).
   * Kill switch desligado → sempre false. IP inválido → false.
   * @param {string|null|undefined} ip
   * @returns {Promise<boolean>}
   */
  async isBlocked(ip) {
    if (!this._enabled) return false;
    const normalized = normalizeIp(ip);
    if (!normalized) return false;
    if (this._fresh(normalized)) {
      inc('ipBlocklistCacheHits');
      const entry = this._entries.get(normalized);
      return Boolean(entry && entry.active);
    }
    inc('ipBlocklistCacheMisses');
    const entry = await this._refresh(normalized);
    return Boolean(entry && entry.active);
  }

  /**
   * Leitura SÍNCRONA do cache em memória (sem banco). Destinada a testes e
   * à hidratação do cold start; o middleware de tráfego DEVE usar `isBlocked`
   * (que respeita TTL/read-through/fail-open).
   */
  peek(ip) {
    const normalized = normalizeIp(ip);
    if (!normalized) return false;
    const entry = this._entries.get(normalized);
    return Boolean(entry && entry.active);
  }

  /**
   * Bloqueia um IP. Aplica em memória IMEDIATAMENTE (não espera o banco,
   * acompanhando o ciclo de vida do hot path) e persiste write-through.
   * Falha de persistência NÃO impede o bloqueio na instância (métrica).
   *
   * @param {string} ip
   * @param {{reason?: string, blockedBy?: string|null}} opts
   * @returns {Promise<{ip: string, active: boolean}>}
   * @throws {Error} .statusCode=422 para IP inválido
   */
  async block(ip, { reason = '', blockedBy = null } = {}) {
    const normalized = normalizeIp(ip);
    if (!normalized) {
      const err = new Error('Endereço de IP inválido.');
      err.statusCode = 422;
      throw err;
    }

    const entry = {
      active: true,
      reason: String(reason || '').trim().slice(0, 255),
      blockedBy: blockedBy || null,
      blockedAt: new Date(this._now()).toISOString(),
    };
    this._entries.set(normalized, entry);
    this._markFetched(normalized);

    if (this._enabled) {
      try {
        await this._repository.block({
          ip: normalized,
          reason: entry.reason,
          blockedBy: entry.blockedBy,
        });
      } catch (error) {
        inc('ipBlocklistPersistenceFailures');
        console.error('Falha ao persistir bloqueio de IP:', error.message);
      }
    }

    return { ip: normalized, active: true };
  }

  /**
   * Desbloqueia um IP (remove do cache imediatamente; persiste write-through).
   * IP não bloqueado não é erro — é idempotente. @returns {Promise<object>}
   */
  async unblock(ip, { unblockedBy = null } = {}) {
    const normalized = normalizeIp(ip);
    if (!normalized) {
      const err = new Error('Endereço de IP inválido.');
      err.statusCode = 422;
      throw err;
    }

    this._drop(normalized);

    if (this._enabled) {
      try {
        try {
          await this._repository.unblock({ ip: normalized, unblockedBy: unblockedBy || null });
        } catch (error) {
          // P2025 = linha inexistente → já está liberado (idempotente).
          if (!(error && error.code === 'P2025')) throw error;
        }
      } catch (error) {
        inc('ipBlocklistPersistenceFailures');
        console.error('Falha ao persistir desbloqueio de IP:', error.message);
      }
    }

    return { ip: normalized, active: false };
  }

  /**
   * Hidrata o cache local com todos os IPs ativamente bloqueados (cold start).
   * Idempotente e tolerante a falhas (nunca rejeita). Uma query só.
   * @returns {Promise<number>} quantidade carregada
   */
  async ensureLoaded() {
    if (this._loaded) return this._loaded;
    if (!this._enabled) {
      this._loaded = Promise.resolve(0);
      return this._loaded;
    }
    this._loaded = this._repository
      .loadActive()
      .then((rows) => {
        this.restore(rows);
        return Array.isArray(rows) ? rows.length : 0;
      })
      .catch((error) => {
        console.error('Falha ao carregar blocklist de IPs:', error.message);
        inc('ipBlocklistFallbacks');
        return 0;
      });
    return this._loaded;
  }

  /**
   * Substitui/adiciona entradas vindas do banco (formato do repositório).
   * @param {Array<{ip: string, active: boolean, reason: string, blockedBy: string|null, blockedAt: Date}>} rows
   */
  restore(rows) {
    if (!Array.isArray(rows)) return this;
    for (const row of rows) {
      if (!row || !row.ip || !row.active) continue;
      this._entries.set(row.ip, {
        active: true,
        reason: row.reason || '',
        blockedBy: row.blockedBy ? String(row.blockedBy) : null,
        blockedAt: row.blockedAt ? new Date(row.blockedAt).toISOString() : new Date(this._now()).toISOString(),
      });
      this._markFetched(row.ip);
    }
    return this;
  }

  /**
   * @returns {Array<{ip: string, reason: string, blockedBy: string|null, blockedAt: string}>} IPs em cache (ativos ou não)
   */
  all() {
    const out = [];
    for (const [ip, entry] of this._entries.entries()) {
      out.push({ ip, ...entry });
    }
    return out;
  }
}

IpBlocklistService._shared = null;
IpBlocklistService.getShared = () => {
  if (!IpBlocklistService._shared) {
    IpBlocklistService._shared = new IpBlocklistService();
  }
  return IpBlocklistService._shared;
};

module.exports = IpBlocklistService;