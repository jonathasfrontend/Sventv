'use strict';

const prisma = require('../prisma/client');

// Limite padrão de requisições por minuto
const DEFAULT_LIMIT = 100;

const floorToMinute = (date = new Date()) => {
  const d = new Date(date);
  d.setSeconds(0, 0);
  return d;
};

const getUserPlanLimit = async (user) => {
  // Sem planos, todos os usuários têm o mesmo limite
  return DEFAULT_LIMIT;
};

const incrementAndGetUsage = async ({ userId, routeKey = 'api' }) => {
  if (!prisma.requestUsage) {
    return {
      count: 1,
      bucketEnd: new Date(Date.now() + 60_000),
    };
  }

  const now = new Date();
  const bucketStart = floorToMinute(now);
  const bucketEnd = new Date(bucketStart.getTime() + 60_000);

  const usage = await prisma.requestUsage.upsert({
    where: {
      userId_bucketStart_routeKey: {
        userId,
        bucketStart,
        routeKey,
      },
    },
    update: {
      requestCount: { increment: 1 },
      bucketEnd,
    },
    create: {
      userId,
      routeKey,
      bucketStart,
      bucketEnd,
      requestCount: 1,
    },
  });

  maybeCleanupOldBuckets();

  return {
    count: usage.requestCount,
    bucketEnd,
  };
};

// ─────────────────────────────────────────────────────────────
// Cleanup: evita crescimento indefinido da tabela RequestUsage.
// Roda probabilisticamente (barato) e remove buckets já expirados
// há mais de 10 minutos — nenhum dado útil depois disso.
// ─────────────────────────────────────────────────────────────

const CLEANUP_PROBABILITY = 0.02; // ~2% das chamadas
const CLEANUP_MAX_AGE_MS = 10 * 60 * 1000;

function maybeCleanupOldBuckets() {
  if (Math.random() >= CLEANUP_PROBABILITY) return;

  prisma.requestUsage
    .deleteMany({
      where: { bucketStart: { lt: new Date(Date.now() - CLEANUP_MAX_AGE_MS) } },
    })
    .catch(() => {
      /* falha de cleanup não pode afetar a request atual */
    });
}

module.exports = {
  getUserPlanLimit,
  incrementAndGetUsage,
};
