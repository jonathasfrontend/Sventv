/**
 * SvenTV API - Configurações Centralizadas da Aplicação
 *
 * Agrupa todas as configurações que dependem de variáveis de ambiente,
 * provendo valores padrão seguros e validação básica.
 */

'use strict';

require('dotenv').config();

const config = {
  // ---- Servidor ----
  port: parseInt(process.env.PORT, 10) || 3000,
  env: process.env.NODE_ENV || 'development',
  isDev: (process.env.NODE_ENV || 'development') === 'development',

  // ---- Banco de Dados (Postgres via Prisma) ----
  db: {
    databaseUrl: process.env.DATABASE_URL || '',
  },

  // ---- JWT - Sessão (token de login do painel/site) ----
  jwt: {
    secret: process.env.JWT_SECRET || 'fallback_dev_secret_mude_em_producao',
    expiresIn: process.env.JWT_SESSION_EXPIRES_IN || '7d',
  },

  // ---- JWT - API Token (token individual de acesso à API) ----
  jwtApi: {
    secret: process.env.JWT_API_SECRET || 'fallback_api_secret_mude_em_producao',
    expiresIn: process.env.JWT_API_EXPIRES_IN || '365d',
  },

  // ---- Segurança ----
  security: {
    bcryptRounds: parseInt(process.env.BCRYPT_ROUNDS, 10) || 12,
    maxLoginAttempts: parseInt(process.env.MAX_LOGIN_ATTEMPTS, 10) || 5,
    lockTimeMinutes: parseInt(process.env.LOCK_TIME_MINUTES, 10) || 15,
  },

  // ---- Rate Limiting ----
  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 60_000,
    global: parseInt(process.env.RATE_LIMIT_MAX_GLOBAL, 10) || 200,
    api: parseInt(process.env.RATE_LIMIT_MAX_API, 10) || 100,
    login: parseInt(process.env.RATE_LIMIT_MAX_LOGIN, 10) || 20,
    stream: parseInt(process.env.RATE_LIMIT_MAX_STREAM, 10) || 50,
    register: parseInt(process.env.RATE_LIMIT_MAX_REGISTER, 10) || 10,
  },

  // ---- Cache ----
  cache: {
    ttlChannels: parseInt(process.env.CACHE_TTL_CHANNELS, 10) || 300,
    ttlCategories: parseInt(process.env.CACHE_TTL_CATEGORIES, 10) || 600,
    ttlStats: parseInt(process.env.CACHE_TTL_STATS, 10) || 120,
  },

  // ---- CORS ----
  cors: {
    origins: process.env.ALLOWED_ORIGINS
      ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
      : ['*'],
  },

  // ---- Supabase Storage ----
  supabase: {
    url: process.env.SUPABASE_URL || '',
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
    bucketAvatars: process.env.SUPABASE_BUCKET_AVATARS || 'SvenTvAvatars',
  },
};

module.exports = config;
