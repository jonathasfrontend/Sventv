/**
 * SvenTV API - Serviço de Cache em Memória
 *
 * Abstrai o node-cache para fornecer cache inteligente
 * para listas de canais, categorias e estatísticas.
 * Projetado para ser substituído por Redis sem alterar a interface.
 */

'use strict';

const NodeCache = require('node-cache');
const logger = require('../utils/logger');
const config = require('../config/app');

// ─────────────────────────────────────────────────────────────
// Instâncias de cache com TTLs distintos
// ─────────────────────────────────────────────────────────────

const channelCache = new NodeCache({
  stdTTL: config.cache.ttlChannels,
  checkperiod: 60,
  useClones: false, // Melhor performance — não clonar objetos grandes
});

const categoryCache = new NodeCache({
  stdTTL: config.cache.ttlCategories,
  checkperiod: 120,
  useClones: false,
});

const statsCache = new NodeCache({
  stdTTL: config.cache.ttlStats,
  checkperiod: 30,
  useClones: false,
});

// Cache genérico para outros dados
const generalCache = new NodeCache({
  stdTTL: 300,
  checkperiod: 60,
  useClones: false,
});

// ─────────────────────────────────────────────────────────────
// Seletor de instância por namespace
// ─────────────────────────────────────────────────────────────

const CACHES = {
  channels: channelCache,
  categories: categoryCache,
  stats: statsCache,
  general: generalCache,
};

/**
 * Retorna a instância de cache correspondente ao namespace.
 * @param {'channels'|'categories'|'stats'|'general'} namespace
 * @returns {NodeCache}
 */
const getCache = (namespace = 'general') => {
  return CACHES[namespace] || generalCache;
};

// ─────────────────────────────────────────────────────────────
// Interface pública
// ─────────────────────────────────────────────────────────────

const cacheService = {
  /**
   * Lê um valor do cache.
   * @param {string} key
   * @param {string} [namespace='general']
   * @returns {*|undefined}
   */
  get(key, namespace = 'general') {
    const value = getCache(namespace).get(key);
    if (value !== undefined) {
      logger.debug(`🟢 Cache HIT [${namespace}] → ${key}`);
    }
    return value;
  },

  /**
   * Armazena um valor no cache.
   * @param {string} key
   * @param {*} value
   * @param {string} [namespace='general']
   * @param {number} [ttl] TTL customizado em segundos (opcional)
   * @returns {boolean}
   */
  set(key, value, namespace = 'general', ttl) {
    const cache = getCache(namespace);
    const success = ttl !== undefined ? cache.set(key, value, ttl) : cache.set(key, value);
    if (success) {
      logger.debug(`🔵 Cache SET [${namespace}] → ${key}`);
    }
    return success;
  },

  /**
   * Remove uma chave do cache.
   * @param {string} key
   * @param {string} [namespace='general']
   */
  del(key, namespace = 'general') {
    getCache(namespace).del(key);
    logger.debug(`🔴 Cache DEL [${namespace}] → ${key}`);
  },

  /**
   * Limpa completamente um namespace de cache.
   * @param {string} [namespace='general']
   */
  flush(namespace = 'general') {
    getCache(namespace).flushAll();
    logger.info(`♻️  Cache FLUSHED [${namespace}]`);
  },

  /**
   * Limpa todos os namespaces.
   */
  flushAll() {
    Object.values(CACHES).forEach((c) => c.flushAll());
    logger.info('♻️  Todos os caches foram limpos.');
  },

  /**
   * Retorna estatísticas de um namespace.
   * @param {string} [namespace='general']
   * @returns {Object}
   */
  stats(namespace = 'general') {
    return getCache(namespace).getStats();
  },

  /**
   * Cache-aside helper: busca do cache; se ausente, executa `fetchFn`,
   * armazena o resultado e o retorna.
   *
   * @param {string} key
   * @param {Function} fetchFn - Função async que retorna o valor
   * @param {string} [namespace='general']
   * @param {number} [ttl] TTL customizado
   * @returns {Promise<*>}
   */
  async getOrSet(key, fetchFn, namespace = 'general', ttl) {
    const cached = this.get(key, namespace);
    if (cached !== undefined) return cached;

    const value = await fetchFn();
    this.set(key, value, namespace, ttl);
    return value;
  },
};

module.exports = cacheService;
