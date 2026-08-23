/**
 * SvenTV API - Configuração do Banco de Dados (Prisma/Postgres)
 *
 * Valida conectividade com o Postgres e mantém o estado da conexão
 * para uso pelos serviços e middlewares.
 */

'use strict';

const logger = require('../utils/logger');
const prisma = require('../prisma/client');
const { setDatabaseConnected } = require('../utils/dbState');
const { bootstrapSaasData } = require('../services/bootstrapService');

/**
 * Conecta ao Postgres via Prisma
 * @returns {Promise<void>}
 */
const connectDB = async () => {
  try {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL não está definida nas variáveis de ambiente.');
    }

    await prisma.$queryRaw`SELECT 1`;
    await bootstrapSaasData();

    setDatabaseConnected(true);
    logger.info('✅ Postgres conectado com sucesso via Prisma.');
  } catch (error) {
    setDatabaseConnected(false);
    logger.error(`❌ Falha ao conectar ao Postgres via Prisma: ${error.message}`);
    // Em produção encerra o processo; em dev permite a API rodar sem banco (modo degradado)
    if (process.env.NODE_ENV === 'production') {
      process.exit(1);
    }
  }
};

/**
 * Garante conexão com o Postgres de forma lazy e idempotente.
 * Usada em serverless (Vercel), onde não há startup único: cada
 * instância fria conecta na primeira requisição e reutiliza a
 * conexão nas seguintes. Em caso de falha, permite nova tentativa
 * na requisição seguinte (sem encerrar o processo).
 * @returns {Promise<void>}
 */
let connectPromise = null;

const ensureDBConnection = () => {
  if (!connectPromise) {
    connectPromise = (async () => {
      try {
        if (!process.env.DATABASE_URL) {
          throw new Error('DATABASE_URL não está definida nas variáveis de ambiente.');
        }

        await prisma.$queryRaw`SELECT 1`;
        await bootstrapSaasData();

        setDatabaseConnected(true);
        logger.info('✅ Postgres conectado com sucesso via Prisma.');
      } catch (error) {
        setDatabaseConnected(false);
        logger.error(`❌ Falha ao conectar ao Postgres via Prisma: ${error.message}`);
        // Reseta para permitir retry na próxima requisição
        connectPromise = null;
      }
    })();
  }
  return connectPromise;
};

// Encerramento gracioso: libera as sessões do pooler imediatamente,
// evitando acúmulo de conexões órfãs entre reinícios (nodemon/redeploy)
const gracefulDbShutdown = async (signal) => {
  setDatabaseConnected(false);
  try {
    await prisma.$disconnect();
    logger.info(`🔌 Banco desconectado graciosamente (${signal}).`);
  } catch {
    // ignora falhas no disconnect durante shutdown
  }
  process.exit(0);
};

process.on('SIGINT', () => gracefulDbShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulDbShutdown('SIGTERM'));

const getDbClient = () => {
  return prisma;
};

module.exports = { connectDB, ensureDBConnection, getDbClient };
