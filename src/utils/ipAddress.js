/**
 * SvenTV API — Utilitários de endereço IP (WAF / IP Access Control)
 *
 * Ponto ÚNICO de resolução do IP do cliente. A instância Express roda com
 * `app.set('trust proxy', 1)` (ver src/app.js): a Vercel REESCREVE o header
 * `x-forwarded-for` no edge com o IP real do cliente — portanto `req.ip` é a
 * fonte autoritativa. NUNCA confiar em `x-forwarded-for` retirado à mão
 * (`.split(',')[0]` a partir do header cru é vulnerável ao cliente injetar
 * o próprio valor antes do proxy).
 *
 * Normalizações aplicadas:
 *   - IPv4-mapped IPv6 (`::ffff:1.2.3.4`) → IPv4 puro (`1.2.3.4`);
 *   - IPv6 → minúsculas (forma canônica; não comprimimos ranges — o bloco é
 *     por endereço exato);
 *   - brackés `[::1]` são removidos;
 *   - `::1` (loopback) é mantido como está.
 * A normalização garante que a MESMA origem trafegando por caminhos distintos
 * (IPv4 vs mapped-IPv6) gere a MESMA chave de bloqueio/rate-limit.
 */

'use strict';

const net = require('net');

/**
 * Extrai e normaliza o IP real do cliente.
 * @param {import('express').Request} req
 * @returns {string|null} IP normalizado ou null quando ausente/indefinido.
 */
function getClientIp(req) {
  if (!req) return null;
  const raw = req.ip || req.socket?.remoteAddress || null;
  return normalizeIp(raw);
}

/**
 * Normaliza um endereço IP p/ chave canônica de bloqueio/cache.
 * @param {string|null|undefined} ip
 * @returns {string|null} versão canônica, ou null se não for IPv4/IPv6 válido.
 */
function normalizeIp(ip) {
  if (!ip || typeof ip !== 'string') return null;
  let value = ip.trim();
  if (!value) return null;

  // Remove colchetes (ex.: "[::1]") se houver.
  if (value.startsWith('[') && value.endsWith(']')) {
    value = value.slice(1, -1);
  }

  // IPv6 pode carregar zona de escopo (ex.: "fe80::1%lo0") — sem suporte.
  if (net.isIP(value) !== 0) {
    // IPv4-mapped IPv6 → IPv4 canônico (evita dupla representação).
    const mapped = value.toLowerCase().match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (mapped) {
      const v4 = mapped[1];
      if (net.isIP(v4) === 4) return v4;
    }
    return value.toLowerCase();
  }

  return null;
}

module.exports = { getClientIp, normalizeIp };