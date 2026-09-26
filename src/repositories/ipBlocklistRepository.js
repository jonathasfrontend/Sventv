/**
 * SvenTV API — Repositório da blocklist de IPs (WAF / IP Access Control)
 *
 * Acesso à tabela `ip_blocklist` (fonte de verdade persistente). O
 * `IpBlocklistService` mantém cache curto em memória e faz read-through aqui;
 * as mutações administrativas (block/unblock) são write-through.
 *
 * Sem FK para `users`: `ip` é a PK natural e o bloqueio é decidido sobre o
 * endereço (atinge todos que o usarem), não sobre uma conta específica.
 */

'use strict';

const prisma = require('../prisma/client');

const ipBlocklistRepository = {
  /**
   * Registro atual do IP (bloqueado ou histórico após unblock) ou null.
   * @param {string} ip - IP já NORMALIZADO (ver src/utils/ipAddress.js)
   */
  async findByIp(ip) {
    if (!ip) return null;
    return prisma.ipBlocklist.findUnique({ where: { ip } });
  },

  /**
   * Registro apenas quando o IP está ATIVAMENTE bloqueado.
   * @param {string} ip
   */
  async findActive(ip) {
    if (!ip) return null;
    return prisma.ipBlocklist.findUnique({ where: { ip, active: true } });
  },

  /**
   * Impõe o bloqueio (upsert): reativa/atualiza a linha do IP resetando o
   * histórico de desbloqueio. Chamado pelo serviço após aplicar em memória
   * (write-through). @returns {Promise<object>} linha persistida
   */
  async block({ ip, reason, blockedBy }) {
    return prisma.ipBlocklist.upsert({
      where: { ip },
      create: {
        ip,
        reason: reason || '',
        blockedBy: blockedBy || null,
        blockedAt: new Date(),
        active: true,
      },
      update: {
        reason: reason || '',
        blockedBy: blockedBy || null,
        blockedAt: new Date(),
        unblockedBy: null,
        unblockedAt: null,
        active: true,
      },
    });
  },

  /**
   * Desbloqueia (mantém a linha como histórico, com active=false e quem
   * desbloqueou). @returns {Promise<object|null>}
   */
  async unblock({ ip, unblockedBy }) {
    return prisma.ipBlocklist.update({
      where: { ip },
      data: {
        active: false,
        unblockedBy: unblockedBy || null,
        unblockedAt: new Date(),
      },
    });
  },

  /**
   * Todos os IPs ATIVAMENTE bloqueados (hidratação de cache no cold start).
   * @returns {Promise<Array<{ip: string, reason: string, blockedBy: string|null, blockedAt: Date}>>}
   */
  async loadActive() {
    return prisma.ipBlocklist.findMany({ where: { active: true } });
  },

  /**
   * Contagem de IPs ativamente bloqueados (painel admin).
   */
  async countActive() {
    return prisma.ipBlocklist.count({ where: { active: true } });
  },

  /**
   * Retenção: apaga registros JÁ desbloqueados e antigos o suficiente
   * (`unblockedAt` fora do limiar de `keepUnblockedSince`).
   * @returns {Promise<number>} quantidade apagada
   */
  async deleteUnblockedOlderThan(keepUnblockedSince) {
    if (!keepUnblockedSince) return 0;
    const result = await prisma.ipBlocklist.deleteMany({
      where: {
        active: false,
        unblockedAt: { not: null, lt: keepUnblockedSince },
      },
    });
    return result.count || 0;
  },
};

module.exports = ipBlocklistRepository;