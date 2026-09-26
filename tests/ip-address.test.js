'use strict';

/**
 * Utilitários de IP (src/utils/ipAddress.js): normalização canônica para
 * chave de bloqueio/cache e extração do IP real a partir do req Express.
 * A normalização garante que IPv4-mapped IPv6 ("::ffff:1.2.3.4") e IPv4
 * ("1.2.3.4") gerem a MESMA chave — sem isso, a blocklist WAF poderia ser
 * contornada trocando a representação.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { getClientIp, normalizeIp } = require('../src/utils/ipAddress');

// ── normalizeIp ──────────────────────────────────────────────

test('normalizeIp: mantém IPv4 canônico', () => {
  assert.equal(normalizeIp('1.2.3.4'), '1.2.3.4');
});

test('normalizeIp: trima espaços', () => {
  assert.equal(normalizeIp('  8.8.8.8  '), '8.8.8.8');
});

test('normalizeIp: converte IPv4-mapped IPv6 em IPv4 puro', () => {
  assert.equal(normalizeIp('::ffff:1.2.3.4'), '1.2.3.4');
});

test('normalizeIp: IPv6 para minúsculas (forma canônica)', () => {
  assert.equal(normalizeIp('2001:DB8::1'), '2001:db8::1');
});

test('normalizeIp: remove colchetes de IPv6', () => {
  assert.equal(normalizeIp('[::1]'), '::1');
});

test('normalizeIp: loopback IPv6 é mantido', () => {
  assert.equal(normalizeIp('::1'), '::1');
});

test('normalizeIp: valores inválidos retornam null', () => {
  assert.equal(normalizeIp('not-an-ip'), null);
  assert.equal(normalizeIp('300.1.2.3'), null);
  assert.equal(normalizeIp('1.2.3.4:80'), null);
  assert.equal(normalizeIp(''), null);
  assert.equal(normalizeIp('   '), null);
  assert.equal(normalizeIp(null), null);
  assert.equal(normalizeIp(undefined), null);
  assert.equal(normalizeIp(123), null);
  assert.equal(normalizeIp({ a: 1 }), null);
});

test('normalizeIp: mesma origem nas duas representações gera a mesma chave', () => {
  assert.equal(normalizeIp('203.0.113.5'), normalizeIp('::ffff:203.0.113.5'));
});

// ── getClientIp ─────────────────────────────────────────────

test('getClientIp: usa req.ip (fonte autoritativa com trust proxy)', () => {
  assert.equal(getClientIp({ ip: '203.0.113.9', socket: { remoteAddress: '10.0.0.1' } }), '203.0.113.9');
});

test('getClientIp: normaliza req.ip IPv4-mapped', () => {
  assert.equal(getClientIp({ ip: '::ffff:203.0.113.9' }), '203.0.113.9');
});

test('getClientIp: cai para req.socket.remoteAddress quando req.ip ausente', () => {
  assert.equal(getClientIp({ socket: { remoteAddress: '192.168.0.7' } }), '192.168.0.7');
});

test('getClientIp: null quando ausente/indefinido', () => {
  assert.equal(getClientIp({}), null);
  assert.equal(getClientIp(null), null);
  assert.equal(getClientIp(undefined), null);
});