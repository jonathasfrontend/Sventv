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
const M3UService = require('./services/m3uService');
const ChannelStateService = require('./services/channelStateService');
const ChannelHealthService = require('./services/channelHealthService');
const { ensureDBConnection } = require('./config/database');
const { errorHandler, notFound, requestLogger } = require('./middlewares/errorHandler');
const { globalLimiter } = require('./middlewares/rateLimiter');
const requestId = require('./middlewares/requestId');
const { sanitizeMongo, sanitizeXss, removeFingerprint, securityLogger } = require('./middlewares/security');

const app = express();

// ── Request ID (primeiro: disponível a todos os demais) ─────

app.use(requestId);

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

// ── Clickjacking ─────────────────────────────────────────────
// SAMEORIGIN para tudo, EXCETO /stream e /proxy (o player é feito
// para ser embutido via iframe — lá o CSP frame-ancestors * já
// foi definido no controller).
app.use((req, res, next) => {
  if (!/^\/api\/channels\/[^/]+\/(stream|proxy)(\/|$|\?)/.test(req.originalUrl || req.url)) {
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  }
  next();
});

// ── Template Engine + Sessão ─────────────────────────────────

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));

// Feature flag do Guia para o SSR (navbar, páginas). Mostra o link de /guia
// quando o EPG está habilitado; EPG_URL ausente mantém a página acessível
// (grade vazia) até a fonte ser configurada — kill switch é só EPG_ENABLED.
app.locals.epgEnabled = Boolean(config.epg.enabled);

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

// ── Prontidão (lazy — serverless) ────────────────────────────
// Na Vercel não há startup único: cada instância fria aguarda
// conexão com o banco e o download do M3U na primeira requisição.
// Nas seguintes, as promises resolvidas são reutilizadas (no-op).
// Páginas HTML não devem ser cacheadas pelo navegador (estado de
// login sempre refletido no SSR).
const sharedM3U = M3UService.getShared();
const channelStates = ChannelStateService.getShared();
const channelHealth = ChannelHealthService.getShared();
app.use((req, res, next) => {
  if (req.method === 'GET' && (req.headers.accept || '').includes('text/html')) {
    res.setHeader('Cache-Control', 'no-store');
  }
  next();
});
app.use(async (_req, _res, next) => {
  try {
    await Promise.all([
      ensureDBConnection(),
      sharedM3U.ensureLoaded().catch((e) => {
        console.error('Falha ao carregar canais:', e.message);
      }),
      // Hidrata o estado administrativo persistido (Postgres) no cold start.
      channelStates.ensureLoaded().catch((e) => {
        console.error('Falha ao carregar estados de canal:', e.message);
      }),
      // Hidrata o active source do failover (Postgres) no cold start, para
      // que os canais não "voltem" para a primária na primeira lambda fria.
      channelHealth.ensureLoaded().catch((e) => {
        console.error('Falha ao carregar failover de canais:', e.message);
      }),
    ]);
    // Espelha o estado persistido nos objetos M3U (`channel.state` alimenta
    // publicChannel/EPG/SSR). Sync: usa o cache já hidratado.
    for (const ch of sharedM3U.getAllChannels()) {
      ch.state = channelStates.peek(ch.id);
    }
  } catch (_) { /* segue degradado; handlers tratam */ }
  next();
});

// ── Rotas ────────────────────────────────────────────────────

app.use('/', webRoutes);
app.use('/api', routes);

// ── Erros ────────────────────────────────────────────────────

app.use(notFound);
app.use(errorHandler);

module.exports = app;
