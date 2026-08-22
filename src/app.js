/**
 * SvenTV API — Express App (Vercel-compatible)
 *
 * Monta todos os middlewares, rotas e configurações no Express.
 * NÃO chama app.listen() nem connectDB() — isso fica no index.js (dev)
 * ou é gerenciado pelo Vercel (serverless).
 */

'use strict';

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');
const cookieParser = require('cookie-parser');
const session = require('express-session');

const config = require('./config/app');
const routes = require('./routes');
const webRoutes = require('./routes/webRoutes');
const { ensureDBConnection } = require('./config/database');
const { errorHandler, notFound, requestLogger } = require('./middleware/errorHandler');
const { globalLimiter } = require('./middlewares/rateLimiter');
const { sanitizeMongo, sanitizeXss, removeFingerprint, securityLogger } = require('./middlewares/security');

const app = express();

// ── Segurança ───────────────────────────────────────────────

app.use(removeFingerprint);
app.use(
  helmet({
    contentSecurityPolicy: false,
    frameguard: false,
  })
);
app.use(
  cors({
    origin: config.cors.origins.includes('*') ? '*' : config.cors.origins,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    credentials: true,
  })
);

// ── Rate Limit + Logging ─────────────────────────────────────

app.use(globalLimiter);
if (config.isDev) {
  app.use(morgan('dev'));
}
app.use(requestLogger);

// ── Body Parsers ─────────────────────────────────────────────

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ── Sanitization ─────────────────────────────────────────────

app.use(sanitizeMongo);
app.use(sanitizeXss);
app.use(securityLogger);

// ── Template Engine + Sessão ─────────────────────────────────

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));

app.use(cookieParser());
app.use(
  session({
    secret: config.jwt.secret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: !config.isDev,
      httpOnly: true,
      maxAge: 7 * 24 * 60 * 60 * 1000,
      sameSite: 'lax',
    },
  })
);

// ── Arquivos Estáticos ───────────────────────────────────────

app.use(express.static(path.join(__dirname, '..', 'public'), { index: false }));
app.use('/Player', express.static(path.join(__dirname, 'Player')));

// ── Conexão com o banco (lazy — serverless) ──────────────────
// Na Vercel não há startup único: cada instância fria conecta
// na primeira requisição; nas seguintes a promise é reutilizada.
app.use(async (_req, _res, next) => {
  await ensureDBConnection();
  next();
});

// ── Rotas ────────────────────────────────────────────────────

app.use('/', webRoutes);
app.use('/api', routes);

// ── Erros ────────────────────────────────────────────────────

app.use(notFound);
app.use(errorHandler);

module.exports = app;
