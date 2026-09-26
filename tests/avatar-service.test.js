/**
 * SvenTV — testes do avatarService (migração v2.0.1: avatar = URL externa)
 *
 * A partir da migração não existe mais upload de arquivo nem Supabase
 * Storage: o serviço exporta `validateAvatarUrl`, `MAX_URL_LENGTH`,
 * `ALLOWED_PROTOCOLS` e `BLOCKED_PROTOCOLS`. Todos os esquemas perigosos
 * (javascript:, data:, file:, ...) e o HTTP puro são recusados; credenciais
 * embutidas são recusadas; hosts não-públicos (privado/loopback/metadata)
 * são recusados pela guarda SSRF (defesa em profundidade — o servidor nunca
 * baixa a imagem, quem carrega é o navegador).
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const avatarService = require('../src/services/avatarService');

const PUBLIC_IP = 'https://8.8.8.8/avatar.png';

const expect422 = async (promise, code) => {
  try {
    await promise;
    assert.fail('esperava rejeição com statusCode 422');
  } catch (err) {
    assert.equal(err.statusCode, 422, `esperado 422, recebido ${err.statusCode}`);
    if (code) assert.equal(err.code, code);
    return err;
  }
};

test('expor constantes esperadas', () => {
  assert.equal(typeof avatarService.validateAvatarUrl, 'function');
  assert.equal(avatarService.MAX_URL_LENGTH, 2048);
  assert.ok(avatarService.ALLOWED_PROTOCOLS instanceof Set);
  assert.ok(avatarService.ALLOWED_PROTOCOLS.has('https:'));
  assert.ok(avatarService.BLOCKED_PROTOCOLS instanceof Set);
});

test('aceita URL HTTPS com host IPv4 público literal (sem DNS)', async () => {
  const out = await avatarService.validateAvatarUrl(PUBLIC_IP);
  assert.equal(out, PUBLIC_IP);
});

test('aceita URL HTTPS válida normalizando o href', async () => {
  const out = await avatarService.validateAvatarUrl(PUBLIC_IP + '?a=1#frag');
  assert.equal(out, PUBLIC_IP + '?a=1#frag');
});

test('aceita trim em volta da URL', async () => {
  const out = await avatarService.validateAvatarUrl(`   ${PUBLIC_IP}   `);
  assert.equal(out, PUBLIC_IP);
});

test('rejeita valor vazio, nulo, não-string ou só espaço', async () => {
  for (const bad of ['', '   ', null, undefined, 42, {}, []]) {
    const { code } = await expect422(avatarService.validateAvatarUrl(bad));
    assert.equal(code, 'INVALID_AVATAR_URL');
  }
});

test('rejeita URL acima de MAX_URL_LENGTH', async () => {
  const tooLong = `${PUBLIC_IP}${'x'.repeat(avatarService.MAX_URL_LENGTH)}`;
  const err = await expect422(avatarService.validateAvatarUrl(tooLong));
  assert.ok(/2048/.test(err.message), 'mensagem deve citar o limite de 2048');
});

test('rejeita URL malformada (não é URL parseável)', async () => {
  for (const bad of ['não é url', 'foo bar', 'https://', 'imagem.png', '//sem-scheme/img.png']) {
    await expect422(avatarService.validateAvatarUrl(bad), 'INVALID_AVATAR_URL');
  }
});

test('rejeita esquemas perigosos e não-permitidos', async () => {
  const cases = [
    'javascript:alert(1)',
    'java\nscript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
    'file:///etc/passwd',
    'ftp://8.8.8.8/avatar.png',
    'ftps://8.8.8.8/avatar.png',
    'sftp://8.8.8.8/avatar.png',
    'tel:+1234',
    'mailto:foo@example.com',
    'ws://8.8.8.8/avatar.png',
    'wss://8.8.8.8/avatar.png',
    'http://8.8.8.8/avatar.png',        // HTTP puro não é mais aceito
    'http://example.com/avatar.png',
    'foo://8.8.8.8/avatar.png',
  ];
  for (const bad of cases) {
    const err = await expect422(avatarService.validateAvatarUrl(bad), 'INVALID_AVATAR_URL');
    assert.ok(/protocolo|HTTPS/i.test(err.message), `mensagem de protocolo esperada para: ${bad}`);
  }
});

test('rejeita credenciais embutidas (user:pass@host)', async () => {
  const err = await expect422(avatarService.validateAvatarUrl('https://user:senha@8.8.8.8/avatar.png'));
  assert.ok(/credenciais/i.test(err.message));
});

test('rejeita URL sem conteúdo parseável (https:// sem host)', async () => {
  await expect422(avatarService.validateAvatarUrl('https://'), 'INVALID_AVATAR_URL');
});

test('rejeita hosts não-públicos via guarda SSRF (SSRF_BLOCKED)', async () => {
  const blockedHosts = [
    'https://127.0.0.1/avatar.png',
    'https://10.0.0.1/avatar.png',
    'https://192.168.1.1/avatar.png',
    'https://169.254.169.254/latest/meta-data/',   // metadata cloud
    'https://[::1]/avatar.png',
  ];
  for (const bad of blockedHosts) {
    const { code } = await expect422(avatarService.validateAvatarUrl(bad));
    assert.equal(code, 'SSRF_BLOCKED');
  }
});

test('mensagem SSRF genérica (não vaza o host)', async () => {
  const err = await expect422(avatarService.validateAvatarUrl('https://169.254.169.254/meta/'), 'SSRF_BLOCKED');
  assert.ok(!/169\.254|metadata|host/.test(err.message), 'mensagem não deve conter o host rejeitado');
  assert.equal(err.message, 'URL de imagem inválida ou inacessível.');
});