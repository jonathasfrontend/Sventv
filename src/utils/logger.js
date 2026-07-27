/**
 * SvenTV API - Logger Estruturado
 *
 * Utiliza Winston para logs com níveis, timestamps e transports
 * configuráveis por ambiente. Em produção, os logs são escritos
 * em arquivo; em desenvolvimento, apenas no console colorido.
 */

'use strict';

const { createLogger, format, transports } = require('winston');
const path = require('path');

const { combine, timestamp, printf, colorize, errors, json } = format;

const isDev = (process.env.NODE_ENV || 'development') === 'development';

// Formato legível para desenvolvimento
const devFormat = combine(
  colorize({ all: true }),
  timestamp({ format: 'HH:mm:ss' }),
  errors({ stack: true }),
  printf(({ level, message, timestamp: ts, stack }) => {
    return stack
      ? `[${ts}] ${level}: ${message}\n${stack}`
      : `[${ts}] ${level}: ${message}`;
  })
);

// Formato JSON para produção (fácil ingestão em Datadog, Loki, etc.)
const prodFormat = combine(
  timestamp(),
  errors({ stack: true }),
  json()
);

const logger = createLogger({
  level: isDev ? 'debug' : 'info',
  format: isDev ? devFormat : prodFormat,
  transports: [
    new transports.Console(),
    // Em produção, escreve logs de erro em arquivo
    ...(!isDev
      ? [
          new transports.File({
            filename: path.join(process.cwd(), 'logs', 'error.log'),
            level: 'error',
            maxsize: 5 * 1024 * 1024, // 5 MB
            maxFiles: 5,
          }),
          new transports.File({
            filename: path.join(process.cwd(), 'logs', 'combined.log'),
            maxsize: 10 * 1024 * 1024, // 10 MB
            maxFiles: 5,
          }),
        ]
      : []),
  ],
  // Não encerra o processo em exceções não capturadas
  exitOnError: false,
});

module.exports = logger;
