/**
 * SvenTV API — Proteção SSRF (Server-Side Request Forgery)
 *
 * Valida que uma URL só pode ser buscada pelo servidor quando resolve para
 * um endereço PÚBLICO. Bloqueia:
 *  - scheme não-http(s) (file://, gopher://, ftp://, ...)
 *  - hostname literais de IP privado/loopback/link-local/metadata/reserved
 *  - hostname DNS que resolva para qualquer endereço não-público
 *
 * Usado no download de avatar por URL (avatarService) — nunca expõe o
 * hostname na resposta ao cliente: mensagens são genéricas.
 */

'use strict';

const dns = require('dns');
const { isIP } = require('net');
const { promisify } = require('util');

const lookup = promisify(dns.lookup);

const isPublicIpv4 = (ip) => {
  const parts = String(ip).split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return false;
  const [a, b, c] = parts;

  if (a === 0) return false;                              // "0.0.0.0/8" (rede atual)
  if (a === 10) return false;                             // RFC 1918 privado
  if (a === 127) return false;                            // loopback
  if (a === 169 && b === 254) return false;               // link-local
  if (a === 172 && b >= 16 && b <= 31) return false;      // RFC 1918 privado
  if (a === 192 && b === 168) return false;               // RFC 1918 privado
  if (a === 100 && b >= 64 && b <= 127) return false;     // CGNAT (RFC 6598)
  if (a === 192 && b === 0 && c === 0) return false;      // IETF protocol assignments
  if (a === 198 && b === 18 && c === 0) return false;     // benchmarking
  if (a === 198 && b === 51 && c === 100) return false;   // documentation
  if (a === 203 && b === 0 && c === 113) return false;    // documentation
  if (a >= 224) return false;                             // multicast + reserved
  return true;
};

const isPublicIpv6 = (ip) => {
  const lower = String(ip).toLowerCase();
  if (lower === '::' || lower === '::1') return false;          // unspecified / loopback
  if (lower.startsWith('::ffff:') || lower.startsWith('::ffff')) {
    // IPv4-mapped → valida o IPv4 final (últimos 32 bits)
    const v4 = lower.split(':').pop();
    if (v4 && /^\d+\.\d+\.\d+\.\d+$/.test(v4)) return isPublicIpv4(v4);
    return false;
  }
  if (lower.startsWith('fc') || lower.startsWith('fd')) return false; // ULA privada
  if (lower.startsWith('fe')) {
    // fe80::/10 link-local (fe80–febf) e fec0::/10 site-local (deprecated)
    const second = parseInt(lower.slice(2, 3) || '0', 16);
    if (!Number.isNaN(second)) return !(second >= 0x8 && second <= 0xf);
  }
  if (lower.startsWith('ff')) return false;               // multicast
  return true;
};

const PUBLIC_SSRF_ERROR = { message: 'URL de imagem inválida ou inacessível.', statusCode: 422, code: 'SSRF_BLOCKED' };

const deny = () => {
  const err = new Error(PUBLIC_SSRF_ERROR.message);
  err.statusCode = PUBLIC_SSRF_ERROR.statusCode;
  err.code = PUBLIC_SSRF_ERROR.code;
  throw err;
};

/**
 * Valida a URL de origem antes de qualquer requisição externa.
 * Lança erro 422 (genérico) quando o destino não é um endereço público.
 *
 * @param {string} urlString
 * @returns {Promise<string>} URL normalizada
 */
const assertSafeUrl = async (urlString) => {
  let url;
  try {
    url = new URL(String(urlString || ''));
  } catch (_) {
    deny();
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') deny();

  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!hostname) deny();

  const ipVersion = isIP(hostname);
  if (ipVersion === 4) {
    if (!isPublicIpv4(hostname)) deny();
    return url.href;
  }
  if (ipVersion === 6) {
    if (!isPublicIpv6(hostname)) deny();
    return url.href;
  }

  // Hostname DNS: resolve e exige que TODOS os endereços sejam públicos.
  // `all: true` cobre hosts que alternam entre IPs (ex.: round-robin CDN).
  let addresses;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch (_) {
    deny();
  }
  if (!Array.isArray(addresses) || addresses.length === 0) deny();

  for (const record of addresses) {
    const family = isIP(record.address);
    const ok = family === 4
      ? isPublicIpv4(record.address)
      : family === 6
        ? isPublicIpv6(record.address)
        : false;
    if (!ok) deny();
  }

  return url.href;
};

module.exports = { assertSafeUrl, isPublicIpv4, isPublicIpv6 };