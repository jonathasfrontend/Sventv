'use strict';

const dns = require('dns');
const net = require('net');
const { URL } = require('url');

/**
 * Guarda anti-SSRF para o proxy de stream.
 *
 * Antes de qualquer requisição HTTP de saída, valida que o host de
 * destino resolve apenas para endereços IP públicos, bloqueando:
 *   - metadata cloud (169.254.169.254) e demais link-local (169.254.0.0/16)
 *   - loopback (127.0.0.0/8, ::1)
 *   - redes privadas (10/8, 172.16/12, 192.168/16)
 *   - ULA IPv6 (fc00::/7)
 *   - link-local IPv6 (fe80::/10)
 *   - multicast (224.0.0.0/4, ff00::/8)
 *
 * Preserva o comportamento do smartLookup existente: hosts que já são IP
 * literal não passam por resolução DNS (evita ENOTFOUND em serverless).
 */

const IPV4_PRIVATE_RANGES = [
  { label: 'loopback',     start: 0x7f000000, end: 0x7fffffff }, // 127.0.0.0/8
  { label: 'private-10',   start: 0x0a000000, end: 0x0affffff }, // 10.0.0.0/8
  { label: 'link-local',   start: 0xa9fe0000, end: 0xa9feffff }, // 169.254.0.0/16
  { label: 'private-172',  start: 0xac100000, end: 0xac1fffff }, // 172.16.0.0/12
  { label: 'private-192',  start: 0xc0a80000, end: 0xc0a8ffff }, // 192.168.0.0/16
  { label: 'multicast',    start: 0xe0000000, end: 0xefffffff }, // 224.0.0.0/4
  { label: 'unspecified',  start: 0x00000000, end: 0x00000000 }, // 0.0.0.0
  { label: 'broadcast',    start: 0xffffffff, end: 0xffffffff }, // 255.255.255.255
];

function isPrivateIPv4(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let num = 0;
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    num = num * 256 + n;
  }
  for (const r of IPV4_PRIVATE_RANGES) {
    if (num >= r.start && num <= r.end) {
      return r.label;
    }
  }
  return null;
}

function isPrivateIPv6(ip) {
  const lower = ip.toLowerCase();
  const hasZone = lower.includes('%');
  const clean = hasZone ? lower.split('%')[0] : lower;

  // ::1 (loopback)
  if (clean === '::1' || clean === '::ffff:127.0.0.1') return 'loopback';

  // IPv4-mapped → delegar à checagem IPv4
  const v4mapped = clean.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4mapped) return isPrivateIPv4(v4mapped[1]);

  // :: / unspecified
  if (clean === '::' || clean === '0:0:0:0:0:0:0:0') return 'unspecified';

  // fe80::/10 (link-local)
  if (clean.match(/^fe[89ab]?[0-9a-f]:/)) return 'link-local-v6';

  // fc00::/7 (ULA) — fc.. e fd..
  if (clean.match(/^[fd][0-9a-f]{3}:/)) return 'ula';

  // ff00::/8 (multicast)
  if (clean.match(/^ff[0-9a-f][0-9a-f]:/)) return 'multicast-v6';

  // ::ffff:a.b.c.d mapped
  return null;
}

/**
 * Retorna o "label" de um IP bloqueado, ou null se o IP é público e seguro.
 * Aceita IPv4 e IPv6 (com ou sem scope zone).
 */
function blockedIPReason(ip) {
  if (net.isIP(ip) === 4) return isPrivateIPv4(ip);
  if (net.isIP(ip) === 6) return isPrivateIPv6(ip);
  return null;
}

/**
 * Resolve o hostname (mantendo o comportamento do smartLookup para IPs
 * literais) e retorna a lista de endereços resolvidos.
 */
function resolveHostname(hostname) {
  const family = net.isIP(hostname);
  if (family) {
    return Promise.resolve([{ address: hostname, family }]);
  }
  return new Promise((resolve, reject) => {
    dns.lookup(hostname, { all: true }, (err, addresses) => {
      if (err) return reject(err);
      resolve(addresses);
    });
  });
}

/**
 * Valida que o destino é seguro para requisição de saída.
 *
 * @param {string|URL} target
 * @param {boolean} [resolveDns=true] deixa `false` quando o chamador já
 *   sabe que a URL é um blob/redirect e o host foi verificado.
 * @returns {Promise<{ok:true}>} resolve quando seguro.
 * @throws {Error} com código `SSRF_BLOCKED` e mensagem genérica (sem IP/URL)
 *   quando o destino é proibido; outras mensagens para erro de DNS/URL.
 */
async function assertSafeTarget(target) {
  let url;
  try {
    url = target instanceof URL ? target : new URL(String(target));
  } catch {
    throw new Error('Destino de stream inválido');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Protocolo de stream não suportado');
  }

  if (!url.hostname) {
    throw new Error('Destino de stream inválido');
  }

  let addresses;
  try {
    addresses = await resolveHostname(url.hostname);
  } catch (err) {
    // Erro de resolução DNS (ex.: ENOTFOUND) → rejeita com código próprio,
    // sem expor o host sensível. O proxy traduz para 502.
    const e = new Error('Resolução de destino falhou');
    e.code = err.code || 'DNS_FAILURE';
    throw e;
  }

  if (!addresses || addresses.length === 0) {
    const e = new Error('Destino de stream inválido');
    e.code = 'SSRF_BLOCKED';
    throw e;
  }

  for (const a of addresses) {
    const reason = blockedIPReason(a.address);
    if (reason) {
      const e = new Error('Destino de stream bloqueado');
      e.code = 'SSRF_BLOCKED';
      e.privateBlockReason = reason;
      throw e;
    }
  }

  return { ok: true };
}

module.exports = {
  assertSafeTarget,
  blockedIPReason,
  resolveHostname,
  IPV4_PRIVATE_RANGES,
};
