/**
 * SvenTV API — Repositório de failover persistido de canais
 *
 * Persistência do ACTIVE SOURCE (primary | backup) na última TRANSIÇÃO do
 * ChannelHealthService. Canais em si estão na M3U (não no banco); apenas o
 * estado de failover precisa sobreviver a restart/cold start — daí esta
 * tabela chaveada por channelId (String, sem FK).
 *
 * Regra de armazenamento: o serviço SÓ chama `upsertHealth` quando a fonte
 * ativa MUDOU (failover/failback) — checagens de rotina fazem ZERO escritas.
 * `consecutiveFails` e `lastSwitchAt` são snapshots informativos da troca;
 * o cold start restaura apenas o activeSource (counters vivos são memória).
 * Falhas devem ser tratadas pelo chamador (fail-open: nunca derrubar o
 * proxy/check por indisponibilidade deste repositório).
 */

'use strict';

const prisma = require('../prisma/client');

const channelHealthRepository = {
  /**
   * Carrega todas as últimas transições registradas para hidratação do
   * active source no cold start.
   */
  async loadAll() {
    const rows = await prisma.channelHealth.findMany();
    return rows.map((r) => ({
      channelId: r.channelId,
      activeSource: r.activeSource,
      consecutiveFails: r.consecutiveFails,
      lastSwitchAt: r.lastSwitchAt,
      updatedAt: r.updatedAt,
    }));
  },

  /**
   * Busca a última transição de um canal. null = nunca houve troca persistida
   * (canal usa fonte primária — default).
   */
  async getHealth(channelId) {
    const row = await prisma.channelHealth.findUnique({ where: { channelId } });
    if (!row) return null;
    return {
      channelId: row.channelId,
      activeSource: row.activeSource,
      consecutiveFails: row.consecutiveFails,
      lastSwitchAt: row.lastSwitchAt,
      updatedAt: row.updatedAt,
    };
  },

  /**
   * Grava/atualiza a última transição. Chamado SOMENTE em troca de fonte.
   */
  async upsertHealth(channelId, { activeSource, consecutiveFails = 0, lastSwitchAt = null }) {
    return prisma.channelHealth.upsert({
      where: { channelId },
      update: { activeSource, consecutiveFails, lastSwitchAt },
      create: { channelId, activeSource, consecutiveFails, lastSwitchAt },
    });
  },

  /**
   * Remove a última transição (canal retorna ao default: primária).
   * Idempotente — apagar registro inexistente (P2025) é NÃO-ERRO.
   */
  async resetHealth(channelId) {
    try {
      return await prisma.channelHealth.delete({ where: { channelId } });
    } catch (error) {
      if (error && error.code === 'P2025') return null;
      throw error;
    }
  },

  /**
   * Remove transições de canais que não existem mais na M3U (limpeza após
   * reload). Retorna o número de linhas apagadas.
   */
  async removeStale(validChannelIds) {
    const ids = Array.isArray(validChannelIds) ? validChannelIds.filter(Boolean) : [];
    if (ids.length === 0) return 0;
    const result = await prisma.channelHealth.deleteMany({
      where: { channelId: { notIn: ids } },
    });
    return result ? result.count : 0;
  },
};

module.exports = channelHealthRepository;