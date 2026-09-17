/**
 * SvenTV API — Serviço de Retenção de dados operacionais
 *
 * Diferente da retenção de ANALYTICS (eventos/sessões brutos, feita pelo
 * analyticsService com limpeza oportunística a cada ingestão), este serviço
 * cobre dados OPERACIONAIS que crescem sem limite atualmente:
 *   - request_usage  → buckets de rate limit por usuário (granularidade
 *                      alta; só precisa existir por alguns dias);
 *   - audit_logs     → trilha de auditoria admin/login/playback (obrigação
 *                      de compliance; retenção maior que a de uso).
 *
 * Disparo: cron da Vercel (POST /api/internal/retention/run) e/ou manual via
 * POST /api/admin/retention/run. Beleza operacional: os deletes usam índices
 * existentes (request_usage_bucket_idx, audit_logs_created_idx).
 *
 * Nunca lança segredos/loga dados sensíveis. Falhas de banco PROPAGAM para o
 * chamador (a rota traduz em 500 genérico) — fail-silent aqui esconderia o
 * problema do cron de manutenção.
 */

'use strict';

const prisma = require('../prisma/client');
const config = require('../config/app');
const { inc } = require('../utils/metrics');

const DAY_MS = 86400_000;

/**
 * Apaga dados operacionais vencidos.
 * @returns {Promise<{requestUsageDeleted: number, auditLogsDeleted: number}>}
 * @throws {Error} em falha de banco (o chamador decide a resposta)
 */
async function runRetention() {
  const now = Date.now();
  const out = { requestUsageDeleted: 0, auditLogsDeleted: 0 };

  inc('retentionRuns');

  // request_usage: bucket com fim antes do corte → nada mais conta para
  // janelas de rate limit; pode ser apagado sem afetar limites ativos.
  if (config.retention.requestUsageDays > 0) {
    const cutoff = new Date(now - config.retention.requestUsageDays * DAY_MS);
    const res = await prisma.requestUsage.deleteMany({
      where: { bucketStart: { lt: cutoff } },
    });
    out.requestUsageDeleted = (res && res.count) || 0;
  }

  // audit_logs: somente eventos mais antigos que o corte.
  if (config.retention.auditLogDays > 0) {
    const cutoff = new Date(now - config.retention.auditLogDays * DAY_MS);
    const res = await prisma.auditLog.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });
    out.auditLogsDeleted = (res && res.count) || 0;
  }

  inc('retentionRequestUsageDeleted', out.requestUsageDeleted);
  inc('retentionAuditLogsDeleted', out.auditLogsDeleted);

  return out;
}

module.exports = { runRetention };