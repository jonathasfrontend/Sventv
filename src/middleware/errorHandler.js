/**
 * SvenTV API - Middleware de Tratamento Centralizado de Erros
 *
 * Cobre erros de validação, Prisma/Postgres, JWT, sistema de arquivos e erros
 * customizados de negócio. Sempre retorna JSON estruturado.
 */

'use strict';

const logger = require('../utils/logger');

/**
 * Middleware principal de erro (4 parâmetros obrigatórios no Express).
 */
const errorHandler = (err, req, res, next) => {
  // Log estruturado do erro
  logger.error({
    message: err.message,
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
    url: req.originalUrl,
    method: req.method,
    ip: req.ip,
    userId: req.user?._id?.toString?.() || req.user?.id,
    requestId: req.id || req.requestId || null,
    timestamp: new Date().toISOString(),
  });

  // ── Validação de schema (Joi/Mongoose-like) ────────────────
  if (err.name === 'ValidationError') {
    const errors = Object.values(err.errors).map((e) => ({
      field: e.path,
      message: e.message,
    }));
    return res.status(422).json({
      success: false,
      message: 'Dados de entrada inválidos.',
      errors,
    });
  }

  // ── Erro de formato inválido de campo ──────────────────────
  if (err.name === 'CastError') {
    return res.status(400).json({
      success: false,
      message: `Valor inválido para o campo '${err.path}': ${err.value}`,
    });
  }

  // ── Chave duplicada (Mongo 11000 / Postgres 23505) ─────────
  if (err.code === 11000) {
    const field = Object.keys(err.keyValue || {})[0] || 'campo';
    const value = err.keyValue?.[field];
    return res.status(409).json({
      success: false,
      message: `Já existe um registro com ${field} = "${value}".`,
    });
  }

  if (err.code === '23505') {
    return res.status(409).json({
      success: false,
      message: 'Registro duplicado para um campo único.',
      detail: err.detail,
    });
  }

  if (err.code === 'P2002') {
    return res.status(409).json({
      success: false,
      message: 'Registro duplicado para um campo único.',
      detail: err.meta?.target,
    });
  }

  if (err.code === 'P2025') {
    return res.status(404).json({
      success: false,
      message: 'Registro não encontrado.',
    });
  }

  // ── JWT: token expirado ────────────────────────────────────
  if (err.name === 'TokenExpiredError') {
    return res.status(401).json({
      success: false,
      message: 'Token expirado. Faça login novamente.',
    });
  }

  // ── JWT: token inválido ────────────────────────────────────
  if (err.name === 'JsonWebTokenError') {
    return res.status(401).json({
      success: false,
      message: 'Token inválido.',
    });
  }

  // ── Sistema de arquivos: não encontrado ───────────────────
  if (err.code === 'ENOENT') {
    return res.status(404).json({
      success: false,
      message: 'Arquivo não encontrado.',
      detail: 'O arquivo M3U não foi localizado.',
    });
  }

  // ── Sistema de arquivos: sem permissão ────────────────────
  if (err.code === 'EACCES') {
    return res.status(403).json({
      success: false,
      message: 'Sem permissão para acessar o recurso solicitado.',
    });
  }

  // ── Erro padrão do servidor ───────────────────────────────
  const status = err.status || err.statusCode || 500;
  res.status(status).json({
    success: false,
    message: status === 500 ? 'Erro interno do servidor.' : err.message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
};

/**
 * Middleware para rotas não encontradas (404).
 */
const notFound = (req, res) => {
  res.status(404).json({
    success: false,
    message: `Rota não encontrada: ${req.method} ${req.originalUrl}`,
    suggestion: 'Consulte a documentação em GET /api/info',
    status: 404,
  });
};

/**
 * Middleware de log de requisições HTTP.
 * Substituído pelo morgan em desenvolvimento; aqui serve como complemento.
 */
const requestLogger = (req, res, next) => {
  const start = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - start;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'http';

    logger[level] || logger.info({
      message: `${req.method} ${req.originalUrl} → ${res.statusCode} (${duration}ms)`,
      method: req.method,
      url: req.originalUrl,
      status: res.statusCode,
      durationMs: duration,
      ip: req.ip,
      requestId: req.id || req.requestId || null,
      userId: req.user?._id?.toString?.() || req.user?.id || null,
    });
  });

  next();
};

module.exports = {
  errorHandler,
  notFound,
  requestLogger,
};
