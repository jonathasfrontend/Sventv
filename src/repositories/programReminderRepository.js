/**
 * SvenTV API — Repositório de lembretes de programação ("Avise-me")
 *
 * Persistência dos lembretes por usuário. Canais NÃO são entidades de banco
 * (vêm da M3U); aqui fica apenas o snapshot mínimo (channelId + título) + a
 * janela de tempo. `notifiedAt` fecha o ciclo two-phase: o cliente dispara a
 * Notification do navegador e CONFIRMA o disparo (evita re-notificar no
 * próximo poll). Regras impostas pelo schema:
 *   - UNIQUE(userId, channelId, startsAt) → duplicado vira erro P2002 (o
 *     serviço converte para 409 antes de chegar ao cliente);
 *   - ON DELETE CASCADE do usuário → lembrete morre junto com a conta.
 */

'use strict';

const prisma = require('../prisma/client');

const programReminderRepository = {
  /**
   * Lista lembretes de um usuário, ordenados por início. Quando `upcoming` é
   * verdadeiro (padrão), retorna apenas os que ainda não começaram.
   */
  async listByUser(userId, { limit = 50, upcoming = true } = {}) {
    const take = Math.min(200, Math.max(1, Number(limit) || 50));
    const rows = await prisma.programReminder.findMany({
      where: {
        userId,
        ...(upcoming ? { startsAt: { gte: new Date() } } : {}),
      },
      orderBy: [{ startsAt: 'asc' }],
      take,
    });
    return rows.map(mapRow);
  },

  /**
   * Busca um lembrete exigindo ownership (userId + id). Usado por operations
   * de um único lembrete — nunca confia em ids do corpo/URL sozinhos.
   */
  async findOwned(userId, id) {
    const row = await prisma.programReminder.findFirst({
      where: { id, userId },
    });
    return row ? mapRow(row) : null;
  },

  /**
   * Já existe lembrete para (usuário, canal, horário)? Base do 409.
   */
  async findExisting(userId, channelId, startsAt) {
    const row = await prisma.programReminder.findFirst({
      where: { userId, channelId, startsAt },
    });
    return row ? mapRow(row) : null;
  },

  /**
   * Total de lembretes ativos (não começados) do usuário — limite por conta.
   */
  async countActive(userId) {
    return prisma.programReminder.count({
      where: { userId, startsAt: { gte: new Date() } },
    });
  },

  async create({ userId, channelId, title, startsAt, stopAt = null }) {
    const row = await prisma.programReminder.create({
      data: {
        userId,
        channelId,
        title,
        startsAt,
        stopAt: stopAt || null,
      },
    });
    return mapRow(row);
  },

  /**
   * Apaga lembrete exigindo ownership (deleteMany defensivo — o schema P2002
   * não se aplica; garantimos que o usuário não mexe no lembrete de outro).
   * Retorna true quando algo foi apagado.
   */
  async remove(userId, id) {
    const result = await prisma.programReminder.deleteMany({
      where: { id, userId },
    });
    return Boolean(result && result.count > 0);
  },

  /**
   * Confirma o disparo (two-phase): marca `notifiedAt` apenas se ainda não
   * notificado. Idempotente — chamadas repetidas não geram escrito extra
   * relevante depois do primeiro sucesso.
   */
  async markNotified(userId, id) {
    const result = await prisma.programReminder.updateMany({
      where: { id, userId, notifiedAt: null },
      data: { notifiedAt: new Date() },
    });
    return Boolean(result && result.count > 0);
  },

  /**
   * Lembretes DENTRO da janela de vencimento e ainda não notificados
   * (usado pelas rotinas de varredura/observabilidade, pelo teste de janela e
   * pelo cron de e-mail do "Avise-me").
   */
  async findDue(fromMs, toMs, { limit = 100 } = {}) {
    const take = Math.min(200, Math.max(1, Number(limit) || 100));
    const rows = await prisma.programReminder.findMany({
      where: {
        startsAt: { gte: new Date(Number(fromMs)), lte: new Date(Number(toMs)) },
        notifiedAt: null,
      },
      orderBy: [{ startsAt: 'asc' }],
      take,
    });
    return rows.map(mapRow);
  },

  /**
   * Marca UMA entrada como notificada pelo cron de e-mail, apenas se ainda
   * não foi (idempotente — protege contra dupla execução entre lambdas).
   */
  async markNotifiedById(id) {
    const result = await prisma.programReminder.updateMany({
      where: { id, notifiedAt: null },
      data: { notifiedAt: new Date() },
    });
    return Boolean(result && result.count > 0);
  },
};

function mapRow(row) {
  return {
    id: row.id,
    userId: row.userId,
    channelId: row.channelId,
    title: row.title,
    startsAt: row.startsAt,
    stopAt: row.stopAt,
    notifiedAt: row.notifiedAt,
    createdAt: row.createdAt,
  };
}

module.exports = programReminderRepository;