'use strict';

const { PrismaClient } = require('@prisma/client');

/**
 * Monta a DATABASE_URL com parâmetros conservadores de pool,
 * sem sobrescrever valores já definidos pelo usuário:
 *
 *  - connection_limit: na Vercel CADA instância lambda tem seu próprio
 *    pool Prisma. Limite alto × N instâncias estoura o pooler do
 *    Supabase em session mode (~15 slots → FATAL EMAXCONNSESSION).
 *    Em serverless o default cai para 1.
 *
 *  - pgbouncer=true: obrigatório ao usar o TRANSACTION POOLER do
 *    Supabase (porta 6543) — desliga as prepared statements do Prisma,
 *    que não sobrevivem ao multiplexing do PgBouncer.
 *
 *  - connect_timeout / pool_timeout: falha rápida em vez de travar a
 *    request esperando slot livre.
 */
const buildDatasourceUrl = () => {
  const url = process.env.DATABASE_URL || '';
  if (!url || url.startsWith('file:')) return url;

  try {
    const parsed = new URL(url);
    const isServerless = Boolean(process.env.VERCEL);
    const isSupabasePooler = parsed.hostname.endsWith('.pooler.supabase.com');

    if (
      parsed.port === '6543' &&
      !parsed.searchParams.has('pgbouncer')
    ) {
      parsed.searchParams.set('pgbouncer', 'true');
    }

    // Session-mode pooler do Supabase (porta 5432 em `*.pooler.supabase.com`)
    // tem teto de ~15 sessões POR PROJETO, compartilhado com qualquer outro
    // consumidor (deploy Vercel, CLI, outro dev). Cada reinício do nodemon que
    // não libera os sockets deixa conexões órfãs no pooler até o idle timeout
    // → FATAL EMAXCONNSESSION em TODA query → resolveUser/POST login falham
    // e a página fica recarregando. Em modo sessão o Prisma segura 1 conexão
    // real por operação: limitar a pool a 1 na API minimiza a disputa pelo teto
    // compartilhado. O transaction pooler (6543) é o caminho recomendado pela
    // app (agrega pgbouncer=true) — ver .env e AGENTS.md.
    const defaultLimit =
      process.env.PRISMA_CONNECTION_LIMIT ||
      (isServerless ? '1' : isSupabasePooler && parsed.port === '5432' ? '1' : '5');

    const defaults = {
      connection_limit: defaultLimit,
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
  globalForPrisma.__sventvPrisma ||
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
    datasources: { db: { url: buildDatasourceUrl() } },
  });

// Cache SEMPRE (inclusive em produção): em serverless o módulo pode ser
// recarregado a frio, mas o globalThis sobrevive entre invocações quentes —
// garante UM único pool por instância lambda.
globalForPrisma.__sventvPrisma = prisma;

module.exports = prisma;
