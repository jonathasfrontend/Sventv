'use strict';

const { PrismaClient } = require('@prisma/client');

/**
 * Garante parâmetros conservadores de pool na DATABASE_URL,
 * sem sobrescrever valores já definidos pelo usuário:
 *  - connection_limit: evita que um único processo consuma todas
 *    as sessões do pooler do Supabase (session mode costuma ter
 *    pool_size baixo, ex.: 15).
 *  - connect_timeout / pool_timeout: falha rápida em vez de travar
 *    a request esperando slot livre.
 */
const buildDatasourceUrl = () => {
  const url = process.env.DATABASE_URL || '';
  if (!url || url.startsWith('file:')) return url;

  try {
    const parsed = new URL(url);
    const defaults = {
      connection_limit: process.env.PRISMA_CONNECTION_LIMIT || '5',
      connect_timeout: '10',
      pool_timeout: '10',
    };
    for (const [key, value] of Object.entries(defaults)) {
      if (!parsed.searchParams.has(key)) parsed.searchParams.set(key, value);
    }
    return parsed.toString();
  } catch {
    return url;
  }
};

const globalForPrisma = globalThis;

const prisma =
  globalForPrisma.__prisma ||
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
    datasources: { db: { url: buildDatasourceUrl() } },
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.__prisma = prisma;
}

module.exports = prisma;