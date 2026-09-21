'use strict';

/**
 * SvenTV API — Rate Limiting
 *
 * Diferentes limitadores de taxa para cada contexto:
 *  - global      → todas as rotas
 *  - login       → prevenção de brute-force
 *  - register    → prevenção de spam de contas
 *  - api         → rotas protegidas por token
 *  - stream      → acesso a streams de vídeo
 *  - user        → rotas /api/user/* (dashboard, playlists, histórico)
 *  - events      → ingestão de eventos de playback (heartbeat 30s não pode ser cortado)
 *  - proxy       → proxy HLS (segmentos; cota própria alta)
 *
 * Stores são híbridas: Upstash Redis (REST, janela fixa atômica) com
 * fallback em memória. Quando o Redis está indisponível, cada limite
 * vale por instância/lambda — falha de infraestrutura de estado NUNCA
 * vira 429 indevido. Métricas: rateLimitRedisFallbacks (por requisição)
 * e redisErrors (eventos reais de erro do Redis).
 */

const rateLimit = require('express-rate-limit');
const config = require('../config/app');
const logger = require('../utils/logger');
const alertService = require('../services/alertService');
const { getUserPlanLimit } = require('../services/rateLimitService');
const redisStore = require('../services/redisStore');
const { inc } = require('../utils/metrics');

// ─────────────────────────────────────────────────────────────
// Store híbrida Redis + fallback em memória
// ─────────────────────────────────────────────────────────────

/**
 * Store compatível com a interface do express-rate-limit v8.
 * Tentativa: Redis (janela fixa atômica). Fallback: memória local.
 *
 * Um store é criado por contexto (global, login, api, stream, ...) e
 * recebe o trecho de chave que o próprio express-rate-limit constrói
 * via keyGenerator/keyGenerator. Chaves finais no Redis:
 *   sventv:rl:{context}:{key}
 */
class RedisRateLimitStore {
  constructor({ context, windowMs }) {
    this._context = context;
    this._windowMs = windowMs;
    this._memory = new Map(); // key -> { totalHits, resetTime }
  }

  _redisKey(key) {
    return redisStore.makeKey('rl', this._context, key);
  }

  _incFallback(key, now) {
    inc('rateLimitRedisFallbacks');
    inc('redisErrors');
  }

  async _incrementFallback(key) {
    const now = Date.now();
    const entry = this._memory.get(key);
    if (!entry || now >= entry.resetTime) {
      const next = { totalHits: 1, resetTime: now + this._windowMs };
      this._memory.set(key, next);
      return { totalHits: 1, resetTime: new Date(next.resetTime) };
    }
    entry.totalHits += 1;
    this._memory.set(key, entry);
    return { totalHits: entry.totalHits, resetTime: new Date(entry.resetTime) };
  }

  /**
   * Tenta incrementar em memória (fallback). Retorna { totalHits, resetTime }.
   * É o que o express-rate-limit v8 espera de `Store.prototype.increment`.
   */
  async increment(key) {
    const now = Date.now();

    if (await redisStore.isRedisAvailable()) {
      try {
        return await redisStore.incrWithTTL(this._redisKey(key), this._windowMs);
      } catch (err) {
        inc('rateLimitRedisFallbacks');
        inc('redisErrors');
        logger.warn(
          `Rate limit Redis não disponível (${this._context}) — fallback memória. ${err && err.message}`
        );
      }
    }

    return this._incrementFallback(key);
  }

  async decrement(key) {
    if (await redisStore.isRedisAvailable()) {
      try {
        await redisStore.decr(this._redisKey(key));
        return;
      } catch (err) {
        inc('rateLimitRedisFallbacks');
        inc('redisErrors');
      }
    }
    const entry = this._memory.get(key);
    if (entry) {
      entry.totalHits = Math.max(0, entry.totalHits - 1);
    }
  }

  /**
   * Zera o contador de um cliente (usado por `retry-after` e reset manual).
   */
  async resetKey(key) {
    if (await redisStore.isRedisAvailable()) {
      try {
        await redisStore.del(this._redisKey(key));
        return;
      } catch (err) {
        inc('rateLimitRedisFallbacks');
        inc('redisErrors');
      }
    }
    this._memory.delete(key);
  }
}

/**
 * Cria um store híbrido com contexto próprio (para usar `store:` nos
 * limitadores individuais).
 */
function hybridStore(context) {
  return new RedisRateLimitStore({
    context,
    windowMs: config.rateLimit.windowMs,
  });
}

/**
 * Store híbrido genérico com contexto E janela (`windowMs`) próprios.
 * Ex.: recuperação de senha usa janela distinta (15 min) da API.
 */
function makeHybridStore(context, windowMs = config.rateLimit.windowMs) {
  return new RedisRateLimitStore({ context, windowMs });
}

/**
 * Cria um store híbrido com TTL próprio (segmentos de stream usam
 * janela própria).
 */
function proxyStore() {
  return new RedisRateLimitStore({
    context: 'proxy',
    windowMs: config.rateLimit.proxyWindowMs,
  });
}

// ─────────────────────────────────────────────────────────────
// Handlers
// ─────────────────────────────────────────────────────────────

const limitHandler = (req, res, _next, options = {}) => {
  logger.warn(`⚠️  Rate limit excedido: ${req.ip} ${req.originalUrl}`);
  const windowMs = options.windowMs || config.rateLimit.windowMs;
  res.status(429).json({
    success: false,
    message: 'Muitas requisições. Aguarde antes de tentar novamente.',
    retryAfterSeconds: Math.ceil(windowMs / 1000),
  });
};

/**
 * Handler específico do registro: além do 429 padrão, dispara alerta admin
 * quando o limite de CRIACAO DE CONTAS é estourado (possível spam/abuso).
 * `eventKey` GENÉRICA (não por usuário) — aqui não há conta por request; o
 * cooldown normal do alertService colapsa rajadas. O IP vai apenas no alerta
 * (canal privado do admin), nunca na resposta pública 429.
 */
function registerLimitHandler(req, res, next, options) {
  alertService.notify('auth.register_rate_limited', {
    event: 'auth.register_rate_limited',
    ip: req.ip || 'unknown',
  });
  return limitHandler(req, res, next, options);
}

// ─────────────────────────────────────────────────────────────
// Limitadores
// ─────────────────────────────────────────────────────────────

/**
 * Limitador global — aplicado a toda a API.
 */
const globalLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.global,
  standardHeaders: true,
  legacyHeaders: false,
  store: hybridStore('global'),
  keyGenerator: (req) => `global_${req.ip}`,
  // Proxy de stream tem limitador dedicado, assets estáticos não devem
  // consumir cota global (seriam contados antes do express.static em app.js)
  // e o bootstrap de credencial do painel web (/api/auth/api-token) é
  // sub-recurso obrigatório das páginas — bloqueá-lo por um bucket anônimo
  // de IP transforma qualquer cota esgotada em 401 no /api/channels e no
  // loop /dashboard↔/login que estoura o rate limit (ver relatórios 09-19).
  skip: (req) => isGlobalExempt(req),
  validate: false,
});

/**
 * Limitador de login (anti brute-force).
 */
const loginLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.login,
  standardHeaders: true,
  legacyHeaders: false,
  store: hybridStore('login'),
  handler: limitHandler,
  keyGenerator: (req) => {
    const email = (req.body?.email || '').toString().toLowerCase();
    return `login_${req.ip}_${email}`;
  },
  validate: false,
});

/**
 * Limitador de registro (anti spam de contas).
 */
const registerLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.register,
  standardHeaders: true,
  legacyHeaders: false,
  store: hybridStore('register'),
  handler: registerLimitHandler,
  keyGenerator: (req) => `register_${req.ip}`,
  validate: false,
});

/**
 * Limitador das rotas de API protegidas (channels, categories, etc.).
 * Identifica pelo usuário autenticado quando disponível, senão pelo IP.
 */
const apiLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: async (req) => {
    if (!req.user?.id) return config.rateLimit.api;
    const limit = await getUserPlanLimit(req.user);
    return Math.max(10, limit);
  },
  standardHeaders: true,
  legacyHeaders: false,
  store: hybridStore('api'),
  handler: limitHandler,
  keyGenerator: (req) => {
    if (req.user?.id) return `api_${req.user.id}`;
    const auth =
      req.headers.authorization || req.query?.token || req.query?.api_token || '';
    return `api_${String(auth).slice(0, 64) || req.ip}`;
  },
  validate: false,
});

/**
 * Limitador de stream — controla acessos ao proxy/player.
 */
const streamLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.stream,
  standardHeaders: true,
  legacyHeaders: false,
  store: hybridStore('stream'),
  handler: limitHandler,
  keyGenerator: (req) => {
    if (req.user?.id) return `stream_${req.user.id}`;
    const token =
      req.query?.token || req.headers.authorization?.replace('Bearer ', '');
    return `stream_${String(token).slice(0, 64) || req.ip}`;
  },
  validate: false,
});

/**
 * Limitador do proxy de stream (segmentos HLS). Janela própria: segmentos
 * de vídeo são rápidos e numerosos — não devem consumir a cota de API.
 */
const proxyLimiter = rateLimit({
  windowMs: config.rateLimit.proxyWindowMs,
  max: config.rateLimit.proxy,
  standardHeaders: true,
  legacyHeaders: false,
  store: proxyStore(),
  handler: limitHandler,
  keyGenerator: (req) => {
    if (req.user?.id) return `proxy_${req.user.id}`;
    const token =
      req.query?.token || req.headers.authorization?.replace('Bearer ', '');
    return `proxy_${String(token).slice(0, 64) || req.ip}`;
  },
  validate: false,
});

/**
 * Limitador de eventos de playback (offsets, heartbeats). Cota generosa:
 * heartbeat a cada ~30s por player. Barra apenas flood/abuso.
 */
const eventsLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.events,
  standardHeaders: true,
  legacyHeaders: false,
  store: hybridStore('events'),
  handler: limitHandler,
  keyGenerator: (req) => {
    if (req.user?.id) return `events_${req.user.id}`;
    return `events_${req.ip}`;
  },
  validate: false,
});

/**
 * Limitador das rotas /api/user/* (dashboard, playlists, histórico).
 */
const userLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: async (req) => {
    if (!req.user?.id) return config.rateLimit.user;
    const limit = await getUserPlanLimit(req.user);
    return Math.max(10, limit);
  },
  standardHeaders: true,
  legacyHeaders: false,
  store: hybridStore('user'),
  handler: limitHandler,
  keyGenerator: (req) => (req.user?.id ? `user_${req.user.id}` : `user_${req.ip}`),
  skip: (req) => isProxyPath(req),
  validate: false,
});

/**
 * Caminhos do proxy de stream que já têm limitador dedicado (proxyLimiter)
 * — não devem consumir as cotas global/user/api.
 */
function isProxyPath(req) {
  return /\/api\/channels\/[^/]+\/proxy/.test(req.path || req.originalUrl || '');
}

/**
 * Assets estáticos servidos por `express.static` (app.js monta o globalLimiter
 * ANTES do static — ver montagem de app.js). Quando um navegador carrega
 * /login ou /dashboard ele dispara dezenas de GETs de /js/*, /css/*, /img/*,
 * /favicon.ico e /Player/* ao mesmo tempo. Sem esta exclusão, todos consomem
 * a cota GLOBAL por IP em rajada — um spike legítimo de página (que até
 * carrega 60+ assets) estoura o bucket global e derruba tudo em 429,
 * incluindo a própria página HTML seguinte (amplificando qualquer loop de
 * reload a um soft-lock por IP).
 */
function isStaticAssetPath(req) {
  const pathname = (req.path || req.originalUrl || '').split('?')[0];
  return (
    /^\/(js|css|img)\//.test(pathname) ||
    /^\/Player\//.test(pathname) ||
    pathname === '/favicon.ico' ||
    /\.(js|css|png|jpe?g|gif|svg|webp|ico|woff2?|map|webmanifest)$/i.test(pathname)
  );
}

/**
 * Endpoint de bootstrap de credencial do painel web: GET /api/auth/api-token
 * (session-gated). É chamado por dashboard/guia/playlists a cada carga de
 * página para obter o API token sob demanda. Só a forma exata (método GET
 * + caminho) é isenta do bucket GLOBAL — login/register/perfil continuam
 * cobertos. Sem esta isenção, um esgotamento transitório do bucket global
 * (mesmo de outro usuário no edge, ver trust proxy) quebra o token do painel
 * → 401 em /api/channels → redireciona a /login → loop + mais 429.
 */
function isAuthTokenPath(req) {
  const pathname = (req.path || req.originalUrl || '').split('?')[0];
  return (req.method || '').toUpperCase() === 'GET' && pathname === '/api/auth/api-token';
}

/**
 * Isenções combinadas do bucket GLOBAL (usado pelo globalLimiter e testado
 * em tests/loop-regression.test.js): proxy HLS, assets estáticos e bootstrap
 * de credencial do painel.
 */
function isGlobalExempt(req) {
  return isProxyPath(req) || isStaticAssetPath(req) || isAuthTokenPath(req);
}

/**
 * Handler dos limitadores de recuperação de senha — barra flood no padrão
 * do projeto (429 JSON) e registra métrica própria.
 */
function passwordResetLimitHandler(req, res, next, options) {
  inc('passwordResetRateLimited');
  return limitHandler(req, res, next, options);
}

/**
 * Limitador de POST /auth/forgot-password — anti-abuso de envio de códigos
 * (anti spam por e-mail). Chave: IP + e-mail normalizado (3/15 min).
 */
const forgotPasswordLimiter = rateLimit({
  windowMs: config.passwordReset.forgotWindowMs,
  max: config.passwordReset.forgotMax,
  standardHeaders: true,
  legacyHeaders: false,
  store: makeHybridStore('forgot-password', config.passwordReset.forgotWindowMs),
  handler: passwordResetLimitHandler,
  keyGenerator: (req) => {
    const email = (req.body?.email || '').toString().trim().toLowerCase();
    return `forgot_${req.ip}_${email}`;
  },
  validate: false,
});

/**
 * Limitador de POST /auth/reset-password — anti brute-force do código.
 * Chave: IP (10/15 min). O próprio serviço já limita tentativas por código.
 */
const resetPasswordLimiter = rateLimit({
  windowMs: config.passwordReset.resetWindowMs,
  max: config.passwordReset.resetMax,
  standardHeaders: true,
  legacyHeaders: false,
  store: makeHybridStore('reset-password', config.passwordReset.resetWindowMs),
  handler: passwordResetLimitHandler,
  keyGenerator: (req) => `reset_${req.ip}`,
  validate: false,
});

/**
 * Limitador de ESCRITA administrativa (role/block/profile/password/avatar/
 * delete). Chave: admin autenticado (jamais IP — admins legítimos podem
 * compartilhar NAT). GETs não consomem cota: a listagem/detalhe já é
 * nociva apenas por volume e fica coberta pelo globalLimiter.
 */
const adminWriteLimiter = rateLimit({
  windowMs: config.rateLimit.adminWriteWindowMs,
  max: config.rateLimit.adminWriteMax,
  standardHeaders: true,
  legacyHeaders: false,
  store: makeHybridStore('admin-write', config.rateLimit.adminWriteWindowMs),
  handler: limitHandler,
  keyGenerator: (req) => `admin_${req.user?.id || req.ip}`,
  skip: (req) => req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS',
  validate: false,
});

module.exports = {
  globalLimiter,
  loginLimiter,
  registerLimiter,
  apiLimiter,
  streamLimiter,
  proxyLimiter,
  userLimiter,
  eventsLimiter,
  forgotPasswordLimiter,
  resetPasswordLimiter,
  adminWriteLimiter,
  RedisRateLimitStore,
  // Helpers de isenção exportados para testes de regressão do loop
  // (docs/RELATORIO-CORRECAO-LOOP-DASHBOARD-*): não devem regredir senão
  // o painel volta a estourar o bucket global.
  isProxyPath,
  isStaticAssetPath,
  isAuthTokenPath,
  isGlobalExempt,
};
