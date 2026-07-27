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

  return {
    count: usage.requestCount,
    bucketEnd,
  };
};

module.exports = {
  getUserPlanLimit,
  incrementAndGetUsage,
};
