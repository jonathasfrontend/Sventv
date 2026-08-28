'use strict';

/**
 * Middleware de Request ID.
 *
 * Gera (ou reutiliza se o cliente enviou `X-Request-Id` válido) um UUID
 * por requisição, exposto no header de resposta `X-Request-Id` e
 * disponível em `req.id`. Permite correlacionar logs, auditoria e erros
 * entre todos os middlewares da mesma requisição.
 *
 * O header de entrada é validado (apenas [A-Za-z0-9._-]) para evitar
 * log forging/injeção.
 */

const crypto = require('crypto');

const SAFE_ID = /^[A-Za-z0-9._-]{1,64}$/;

function requestId(req, res, next) {
  const incoming = req.headers['x-request-id'];
  let id;

  if (typeof incoming === 'string' && incoming.trim() && SAFE_ID.test(incoming.trim())) {
    id = incoming.trim();
  } else {
    id = crypto.randomUUID();
  }

  req.id = id;
  req.requestId = id;
  res.setHeader('X-Request-Id', id);

  next();
}

module.exports = requestId;
