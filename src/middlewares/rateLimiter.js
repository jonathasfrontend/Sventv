/**
 * SvenTV API - Rate Limiting
 *
 * Diferentes limitadores de taxa para cada contexto:
 *  - global      → todas as rotas
 *  - login       → prevenção de brute-force
 *  - register    → prevenção de spam de contas
 *  - api         → rotas protegidas por token
 *  - stream      → acesso a streams de vídeo
 *
 * Utiliza express-rate-limit com store em memória.
 * Para produção com múltiplas instâncias, substitua por RedisStore.
 */

'use strict';

const rateLimit = require('express-rate-limit');
const config = require('../config/app');
const logger = require('../utils/logger');
const { getUserPlanLimit, incrementAndGetUsage } = require('../services/rateLimitService');

// ─────────────────────────────────────────────────────────────
// Handler padrão quando limite é excedido
// ─────────────────────────────────────────────────────────────

const limitHandler = (req, res, _next, options) => {
  logger.warn(
    `⚠️  Rate limit excedido: IP=${req.ip} | Rota=${req.originalUrl} | Limite=${options.max}`
  );
  res.status(429).json({
    success: false,
    message: 'Muitas requisições. Por favor, aguarde antes de tentar novamente.',
    retryAfter: Math.ceil(config.rateLimit.windowMs / 1000),
  });
};

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
  handler: limitHandler,
});

/**
 * Limitador para rota de login — proteção contra brute-force.
 */
const loginLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.login,
  standardHeaders: true,
  legacyHeaders: false,
  handler: limitHandler,
  // Identifica pelo IP + email para evitar bloqueio indevido de IPs compartilhados
  keyGenerator: (req) => {
    const email = req.body?.email ? String(req.body.email).toLowerCase() : '';
    return `${req.ip}_${email}`;
  },
  validate: false, // Desativa validações automáticas para keyGenerator customizado
});

/**
 * Limitador para rota de registro.
 */
const registerLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.register,
  standardHeaders: true,
  legacyHeaders: false,
  handler: limitHandler,
});

/**
 * Limitador para rotas da API protegidas (channels, categories, etc.).
 * Identifica pelo token da API quando disponível, senão pelo IP.
 */
const apiLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: async (req) => {
    if (!req.user) return config.rateLimit.api;
    return getUserPlanLimit(req.user);
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: limitHandler,
  keyGenerator: (req) => {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      return `api_${authHeader.slice(7, 47)}`; // Prefixo do token como chave
    }
    return req.query?.token ? `api_${String(req.query.token).slice(0, 40)}` : `api_${req.ip}`;
  },
  validate: false,
  skip: async (req, res) => {
    if (!req.user?.id) return false;

    const limit = await getUserPlanLimit(req.user);
    const usage = await incrementAndGetUsage({
      userId: req.user.id,
      routeKey: 'api',
      userPlanCode: req.user.plan,
    });

    res.setHeader('X-Plan-Limit', String(limit));
    res.setHeader('X-Plan-Usage', String(usage.count));

    if (usage.count > limit) {
      logger.warn(
        `⚠️  Rate limit por plano excedido: user=${req.user.id} plan=${req.user.plan} count=${usage.count}/${limit}`
      );
      res.status(429).json({
        success: false,
        message: 'Limite de requisicoes por plano excedido para este minuto.',
        currentPlan: req.user.plan,
        limitPerMinute: limit,
      });
      return true;
    }

    return false;
  },
});

/**
 * Limitador para rotas de streaming.
 */
const streamLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: async (req) => {
    if (!req.user) return config.rateLimit.stream;
    const planLimit = await getUserPlanLimit(req.user);
    return Math.max(10, Math.floor(planLimit / 2));
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: limitHandler,
  keyGenerator: (req) => {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      return `stream_${authHeader.slice(7, 47)}`;
    }
    return `stream_${req.ip}`;
  },
  validate: false,
  skip: async (req, res) => {
    if (!req.user?.id) return false;

    const planLimit = await getUserPlanLimit(req.user);
    const streamLimit = Math.max(10, Math.floor(planLimit / 2));
    const usage = await incrementAndGetUsage({
      userId: req.user.id,
      routeKey: 'stream',
      userPlanCode: req.user.plan,
    });

    res.setHeader('X-Stream-Plan-Limit', String(streamLimit));
    res.setHeader('X-Stream-Usage', String(usage.count));

    if (usage.count > streamLimit) {
      res.status(429).json({
        success: false,
        message: 'Limite de stream por plano excedido para este minuto.',
        currentPlan: req.user.plan,
        limitPerMinute: streamLimit,
      });
      return true;
    }

    return false;
  },
});

module.exports = {
  globalLimiter,
  loginLimiter,
  registerLimiter,
  apiLimiter,
  streamLimiter,
};
