/**
 * SvenTV API — Entry Point (Local Dev)
 *
 * Para Vercel, usar src/app.js (sem listen/connectDB).
 * Este arquivo é usado apenas para desenvolvimento local.
 */

'use strict';

require('dotenv').config();

const config = require('./src/config/app');
const { connectDB } = require('./src/config/database');
const app = require('./src/app');
const logger = require('./src/utils/logger');

const startServer = async () => {
  await connectDB();

  const server = app.listen(config.port, () => {
    logger.info('================================================');
    logger.info('🎬 SvenTV API v2 — Servidor Iniciado!');
    logger.info('================================================');
    logger.info(`📡 Porta       : ${config.port}`);
    logger.info(`🌍 Ambiente    : ${config.env}`);
    logger.info(`🔗 URL Local   : http://localhost:${config.port}`);
    logger.info(`📚 Docs        : http://localhost:${config.port}/api/info`);
    logger.info(`❤️  Health      : http://localhost:${config.port}/api/health`);
    logger.info('================================================');
  });

  const shutdown = (signal) => {
    logger.warn(`\n⚠️  ${signal} recebido. Encerrando graciosamente...`);
    server.close(() => {
      logger.info('✅ Servidor encerrado com sucesso.');
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('uncaughtException', (error) => {
    logger.error(`❌ Exceção não capturada: ${error.message}`, { stack: error.stack });
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    logger.error(`❌ Promise rejeitada não tratada: ${reason}`);
    process.exit(1);
  });

  return server;
};

startServer().catch((err) => {
  logger.error(`Falha ao iniciar o servidor: ${err.message}`);
  process.exit(1);
});

module.exports = app;
