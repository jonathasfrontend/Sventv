'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const M3UService = require('../src/services/m3uService');

// Instância sem I/O: reutiliza os métodos do protótipo e injeta `channels`.
function makeService() {
  const svc = Object.create(M3UService.prototype);
  svc.channels = [];
  return svc;
}

const entry = (name, url, group = 'Filmes') =>
  `#EXTINF:-1 tvg-id="" tvg-name="${name}" tvg-logo="" group-title="${group}",${name}\n${url}\n`;

test('parseM3U inicializa url/primaryUrl/urls/state (default live)', () => {
  const svc = makeService();
  svc.parseM3U(entry('Canal A', 'http://a.example/1.m3u8'), 'a.m3u');

  const ch = svc.channels[0];
  assert.equal(ch.url, 'http://a.example/1.m3u8');
  assert.equal(ch.primaryUrl, 'http://a.example/1.m3u8');
  assert.deepEqual(ch.urls, ['http://a.example/1.m3u8']);
  assert.equal(ch.state, 'live');
  assert.equal(ch.backupUrl, undefined);
});

test('removeDuplicates agrega segunda fonte distinta como backupUrl', () => {
  const svc = makeService();
  svc.parseM3U(entry('Canal A', 'http://a.example/1.m3u8'), 'a.m3u');
  svc.parseM3U(entry('Canal A', 'http://b.example/1.m3u8'), 'b.m3u');
  svc.removeDuplicates();

  assert.equal(svc.channels.length, 1);
  const ch = svc.channels[0];
  assert.equal(ch.url, 'http://a.example/1.m3u8');
  assert.equal(ch.primaryUrl, 'http://a.example/1.m3u8');
  assert.equal(ch.backupUrl, 'http://b.example/1.m3u8');
  assert.equal(ch.backupSource, 'b.m3u');
  assert.equal(ch.urls.length, 2);
});

test('removeDuplicates ignora URL repetida e mantém o id da primeira ocorrência', () => {
  const svc = makeService();
  svc.parseM3U(entry('Canal A', 'http://a.example/1.m3u8'), 'a.m3u');
  const firstId = svc.channels[0].id;

  svc.parseM3U(entry('Canal A', 'http://a.example/1.m3u8'), 'outra.m3u');
  svc.removeDuplicates();

  assert.equal(svc.channels.length, 1);
  assert.equal(svc.channels[0].id, firstId);
  assert.equal(svc.channels[0].backupUrl, undefined);
  assert.equal(svc.channels[0].urls.length, 1);
});

test('removeDuplicates mantém canais com nomes distintos separados', () => {
  const svc = makeService();
  svc.parseM3U(entry('Canal A', 'http://a.example/1.m3u8'), 'a.m3u');
  svc.parseM3U(entry('Canal B', 'http://a.example/2.m3u8'), 'a.m3u');
  svc.removeDuplicates();

  assert.equal(svc.channels.length, 2);
  assert.equal(svc.channels[0].backupUrl, undefined);
  assert.equal(svc.channels[1].backupUrl, undefined);
});
