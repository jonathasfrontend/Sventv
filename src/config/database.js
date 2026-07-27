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

// Garante atualização de estado ao encerrar o processo
process.on('SIGINT', async () => {
  setDatabaseConnected(false);
  await prisma.$disconnect();
  logger.info('Banco de dados marcado como desconectado pelo encerramento da aplicação.');
  process.exit(0);
});

const getDbClient = () => {
  return prisma;
};

module.exports = { connectDB, getDbClient };
