'use strict';

/**
 * Hardening do avatarService para a missão admin:
 *  - SVG EXCLUÍDO dos formatos aceitos (ALLOWED_MIME);
 *  - validação por MAGIC BYTES (o servidor confia no conteúdo, não no MIME
 *    declarado pelo cliente);
 *  - recusa precoce de uploads grandes/ausentes ANTES de tocar o storage.
 * Sem rede: SSRF e upload Supabase não são exercitados aqui.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const avatarService = require('../src/services/avatarService');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
const GIF = Buffer.concat([Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]), Buffer.alloc(64)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(16)]);
const SVG_TEXT = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

const expect422 = (promiseOrFn, messagePart) =>
  assert.rejects(
    typeof promiseOrFn === 'function' ? promiseOrFn : () => promiseOrFn,
    (err) => {
      assert.equal(err.statusCode, 422);
      if (messagePart) assert.ok(String(err.message).includes(messagePart));
      return true;
    }
  );

test('detectImageMime: identifica JPG, PNG, GIF e WebP pelos magic bytes', () => {
  assert.equal(avatarService.detectImageMime(JPG), 'image/jpeg');
  assert.equal(avatarService.detectImageMime(PNG), 'image/png');
  assert.equal(avatarService.detectImageMime(GIF), 'image/gif');
  assert.equal(avatarService.detectImageMime(WEBP), 'image/webp');
});

test('detectImageMime: NÃO reconhece SVG nem conteúdo textual/binário vazio', () => {
  assert.equal(avatarService.detectImageMime(SVG_TEXT), null);
  assert.equal(avatarService.detectImageMime(Buffer.from('não é imagem')), null);
  assert.equal(avatarService.detectImageMime(Buffer.alloc(0)), null);
});

test('validateImageBuffer: SVG (mesmo declarado) é recusado — formato não suportado', () => {
  assert.throws(() => avatarService.validateImageBuffer(SVG_TEXT, 'image/svg+xml'), (err) => err.statusCode === 422);
  assert.throws(() => avatarService.validateImageBuffer(SVG_TEXT, 'image/png'), (err) => err.statusCode === 422);
});

test('validateImageBuffer: mismatch entre MIME declarado e conteúdo real é recusado', () => {
  assert.throws(() => avatarService.validateImageBuffer(GIF, 'image/png'), (err) => err.statusCode === 422);
  assert.throws(() => avatarService.validateImageBuffer(PNG, 'image/jpeg'), (err) => err.statusCode === 422);
  assert.throws(() => avatarService.validateImageBuffer(Buffer.from('texto puro'), 'image/png'), (err) => err.statusCode === 422);
});

test('validateImageBuffer: aceita apenas conteúdo que casa com o MIME declarado', () => {
  avatarService.validateImageBuffer(PNG, 'image/png');
  avatarService.validateImageBuffer(JPG, 'image/jpeg');
  avatarService.validateImageBuffer(GIF, 'image/gif');
  avatarService.validateImageBuffer(WEBP, 'image/webp');
});

test('ALLOWED_MIME: não contém imagem SVG', () => {
  assert.equal(avatarService.ALLOWED_MIME.has('image/svg+xml'), false);
  assert.equal(avatarService.ALLOWED_MIME.has('image/svg'), false);
});

test('uploadAvatar: recusa sem arquivo nem URL', async () => {
  await expect422(avatarService.uploadAvatar({ userId: 'u1' }));
});

test('uploadAvatar: recusa arquivo acima de 5MB antes de tocar o storage', async () => {
  const big = Buffer.alloc(5 * 1024 * 1024 + 1);
  await expect422(() =>
    avatarService.uploadAvatar({ file: { buffer: big, mimetype: 'image/png', size: big.length }, userId: 'u1' })
  );
});