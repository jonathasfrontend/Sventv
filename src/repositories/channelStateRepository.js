/**
 * SvenTV API — Repositório de estado administrativo de canais
 *
 * Persistência do estado (live | maintenance | blocked) aplicado pelo admin.
 * Canais em si NÃO estão no banco (vêm da M3U), mas o estado precisa
 * sobreviver a restart/cold start — daí esta tabela chaveada por channelId
 * (String, sem FK). Regra de armazenamento:
 *   - states != 'live'  → linha upserted (atualiza state/reason/setBy);
 *   - state == 'live'   → linha DELETADA (live é o default; tabela fica
 *                         enxuta e só contém o que difere do padrão).
 * O ChannelStateService mantém cache curto (CHANNEL_STATE_CACHE_TTL_MS) e
 * faz read-through aqui. Falhas devem ser tratadas pelo chamador (fail-open:
 * nunca derrubar stream/req por indisponibilidade deste repositório).
 */

'use strict';

const prisma = require('../prisma/client');

const channelStateRepository = {
  /**
   * Carrega todos os estados registrados (não-'live') para hidratação do
   * cache local no cold start.
   */
  async loadAll() {
    const rows = await prisma.channelState.findMany();
    return rows.map((r) => ({
      channelId: r.channelId,
      state: r.state,
      reason: r.reason,
      setBy: r.setBy,
      updatedAt: r.updatedAt,
    }));
  },

  /**
   * Busca o estado de um único canal. Retorna null quando o canal está no
   * estado padrão (live, nunca registrado).
   */
  async getState(channelId) {
    const row = await prisma.channelState.findUnique({ where: { channelId } });
    if (!row) return null;
    return {
      channelId: row.channelId,
      state: row.state,
      reason: row.reason,
      setBy: row.setBy,
      updatedAt: row.updatedAt,
    };
  },

  /**
   * Grava um estado != 'live' (cria ou atualiza).
   */
  async upsertState(channelId, { state, reason = '', setBy = null }) {
    return prisma.channelState.upsert({
      where: { channelId },
      update: { state, reason, setBy },
      create: { channelId, state, reason, setBy },
    });
  },

  /**
   * Restaura o estado padrão (live): apaga a linha. Idempotente — apagar
   * registro que não existe (P2025) é NÃO-ERRO.
   */
  async resetState(channelId) {
    try {
      return await prisma.channelState.delete({ where: { channelId } });
    } catch (error) {
      if (error && error.code === 'P2025') return null;
      throw error;
    }
  },

  /**
   * Remove estados de canais que não existem mais na M3U (limpeza após
   * reload). Retorna o número de linhas apagadas.
   */
  async removeStale(validChannelIds) {
    const ids = Array.isArray(validChannelIds) ? validChannelIds.filter(Boolean) : [];
    if (ids.length === 0) return 0;
    const result = await prisma.channelState.deleteMany({
      where: { channelId: { notIn: ids } },
    });
    return result ? result.count : 0;
  },
};

module.exports = channelStateRepository;