'use strict';

/**
 * Guarda SSRF (src/utils/ssrfGuard.js): URLs só podem apontar para endereços
 * PÚBLICOS (IPv4/IPv6 literal ou DNS). Bloqueia loopback, privados,
 * link-local, CGNAT, documentação, multicast e schemes não-http(s), com
 * mensagem GENÉRICA — nunca expõe o host na resposta. Tudo offline-safe
 * (sem resolução DNS real nos casos testados).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { assertSafeUrl, isPublicIpv4, isPublicIpv6 } = require('../src/utils/ssrfGuard');

const expectBlocked = async (url) => {
  await assert.rejects(
    () => assertSafeUrl(url),
    (err) => {
      assert.equal(err.statusCode, 422);
      assert.equal(err.code, 'SSRF_BLOCKED');
      if (String(url)) assert.ok(!String(err.message).includes(String(url)), 'mensagem não deve expor a URL/host');
      return true;
    }
  );
};

test('isPublicIpv4: bloqueia privados, loopback, link-local, CGNAT, docs e multicast', () => {
  const blocked = [
    '0.0.0.0',
    '127.0.0.1',
    '10.0.0.1',
    '172.16.0.0',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '198.18.0.1',
    '198.51.100.7',
    '203.0.113.9',
    '224.0.0.1',
    '255.255.255.255',
  ];
  for (const ip of blocked) assert.equal(isPublicIpv4(ip), false, `deveria bloquear ${ip}`);

  const publicIps = ['8.8.8.8', '1.1.1.1', '104.16.1.1', '93.184.216.34', '203.0.114.5'];
  for (const ip of publicIps) assert.equal(isPublicIpv4(ip), true, `deveria aceitar ${ip}`);
});

test('isPublicIpv6: bloqueia loopback, ULA, link-local, site-local e multicast', () => {
  const blocked = ['::', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'fec0::1', 'ff02::1'];
  for (const ip of blocked) assert.equal(isPublicIpv6(ip), false, `deveria bloquear ${ip}`);

  assert.equal(isPublicIpv6('::ffff:8.8.8.8'), true);
  assert.equal(isPublicIpv6('2606:4700:4700::1111'), true);
});

test('assertSafeUrl: rejeita scheme não-http(s)', async () => {
  await expectBlocked('file:///etc/passwd');
  await expectBlocked('ftp://example.com/arquivo');
  await expectBlocked('gopher://localhost/');
  await expectBlocked('javascript:alert(1)');
});

test('assertSafeUrl: rejeita IPs literais não-públicos', async () => {
  await expectBlocked('http://127.0.0.1/');
  await expectBlocked('http://10.0.0.5/proxy-admin');
  await expectBlocked('http://169.254.169.254/latest/meta-data/');
  await expectBlocked('http://[::1]/x');
  await expectBlocked('https://192.168.0.10/painel');
});

test('assertSafeUrl: aceita IPs literais públicos sem resolver DNS', async () => {
  assert.equal(await assertSafeUrl('https://8.8.8.8/'), 'https://8.8.8.8/');
  assert.equal(await assertSafeUrl('https://143.198.10.100/avatar'), 'https://143.198.10.100/avatar');
});

test('assertSafeUrl: rejeita entrada vazia/mal-formada', async () => {
  await expectBlocked('');
  await expectBlocked('não é uma url');
  await expectBlocked(null);
});