/**
 * SvenTV API - Servidor de Streaming de Canais de TV
 *
 * API profissional para streaming de TV ao vivo com:
 *  - Autenticação JWT (sessão + API token exclusivo)
 *  - Postgres (Supabase) via Prisma para persistência de usuários
 *  - Rate limiting por IP e por token
 *  - Proteção contra NoSQL Injection, XSS, hotlinking
 *  - Cache em memória para performance
 *  - Logs estruturados com Winston
 *
 * Autor: Jonathas Enterprises
 * Versão: 2.0.0
 * License: LICENSE
 */

'use strict';

// ─── Carrega variáveis de ambiente ANTES de qualquer módulo ───
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');
const cookieParser = require('cookie-parser');
const session = require('express-session');

// ─── Módulos internos ─────────────────────────────────────────
const config = require('./src/config/app');
const { connectDB } = require('./src/config/database');
const routes = require('./src/routes');
const webRoutes = require('./src/routes/webRoutes');
const { errorHandler, notFound, requestLogger } = require('./src/middleware/errorHandler');
const { globalLimiter } = require('./src/middlewares/rateLimiter');
const { sanitizeMongo, sanitizeXss, removeFingerprint, securityLogger } = require('./src/middlewares/security');
const { formatUptime } = require('./src/utils/helpers');
const logger = require('./src/utils/logger');

// ─────────────────────────────────────────────────────────────
// Inicialização do Express
// ─────────────────────────────────────────────────────────────

const app = express();

// ─────────────────────────────────────────────────────────────
// Middlewares de segurança (devem ser os primeiros)
// ─────────────────────────────────────────────────────────────

// Remove headers que identificam o servidor
app.use(removeFingerprint);

// Helmet - headers de segurança HTTP (CSP desabilitado para suporte a iframe)
app.use(
  helmet({
    contentSecurityPolicy: false,
    frameguard: false,
  })
);

// CORS configurável via .env
app.use(
  cors({
    origin: config.cors.origins.includes('*') ? '*' : config.cors.origins,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    credentials: true,
  })
);

// Rate limiter global (todas as rotas)
app.use(globalLimiter);

// Logging HTTP
if (config.isDev) {
  app.use(morgan('dev'));
}
app.use(requestLogger);

// Parsers de corpo
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Proteção contra NoSQL Injection e XSS
app.use(sanitizeMongo);
app.use(sanitizeXss);

// Log de requests suspeitos
app.use(securityLogger);

// ─────────────────────────────────────────────────────────────
// Template Engine (EJS) + Sessão Web
// ─────────────────────────────────────────────────────────────

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(cookieParser());
app.use(
  session({
    secret: config.jwt.secret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: !config.isDev,   // https em produção
      httpOnly: true,
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 dias
      sameSite: 'lax',
    },
  })
);

// ─────────────────────────────────────────────────────────────
// Arquivos estáticos (index: false para NÃO servir public/index.html em /)
// ─────────────────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, 'public'), { index: false }));
app.use('/Player', express.static(path.join(__dirname, 'src/Player')));

// ─────────────────────────────────────────────────────────────
// Rotas Web (páginas EJS — ANTES das rotas de API)
// ─────────────────────────────────────────────────────────────

app.use('/', webRoutes);

// ─────────────────────────────────────────────────────────────
// Rotas da API
// ─────────────────────────────────────────────────────────────

app.use('/api', routes);

// ─────────────────────────────────────────────────────────────
// Middlewares de erro (sempre por último)
// ─────────────────────────────────────────────────────────────

app.use(notFound);
app.use(errorHandler);

// ─────────────────────────────────────────────────────────────
// Boot: conecta ao banco e inicia o servidor
// ─────────────────────────────────────────────────────────────

const startServer = async () => {
  // Conecta ao Postgres via Prisma (não bloqueia a API se falhar em dev)
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
    logger.info('� Autenticação JWT ativada');
    logger.info('🛡️  Rate limiting ativado');
    logger.info('🔒 Proteções de segurança ativadas');
    logger.info('================================================\n');
  });

  // ── Graceful shutdown ──────────────────────────────────────

  const shutdown = (signal) => {
    logger.warn(`\n⚠️  ${signal} recebido. Encerrando graciosamente...`);
    server.close(() => {
      logger.info('✅ Servidor encerrado com sucesso.');
      process.exit(0);
    });
    // Força encerramento após 10s se alguma conexão travar
    setTimeout(() => process.exit(1), 10_000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // ── Erros não capturados ───────────────────────────────────

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
