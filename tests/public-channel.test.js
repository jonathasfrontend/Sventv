'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { toPublicChannel, toPublicChannels } = require('../src/utils/publicChannel');
const { channelSnapshot } = require('../src/services/playbackService');

const internal = {
  id: 'abc123',
  name: 'Canal Teste',
  cleanName: 'canal-teste',
  originalName: 'Canal Teste',
  tvgId: 'tvg.1',
  logo: 'https://img.example.com/logo.png',
  category: 'Filmes;Ação',
  slug: 'canal-teste',
  quality: '720p',
  availability: 'Disponível',
  format: 'HLS',
  encryption: 'none',
  isLive: true,
  state: 'maintenance',
  url: 'http://192.168.1.10:8080/playlist.m3u8',
  primaryUrl: 'http://192.168.1.10:8080/playlist.m3u8',
  backupUrl: 'http://10.0.0.5:8080/backup.m3u8',
  backupSource: 'backup.m3u',
  urls: ['http://192.168.1.10:8080/playlist.m3u8', 'http://10.0.0.5:8080/backup.m3u8'],
  source: 'https://m3u.remota.example/lista.m3u8',
};

test('toPublicChannel remove url/source (nunca expõe origem upstream)', () => {
  const pub = toPublicChannel(internal);
  assert.equal(pub.id, 'abc123');
  assert.equal(pub.name, 'Canal Teste');
  assert.equal(pub.logo, 'https://img.example.com/logo.png');
  assert.equal(pub.state, 'maintenance');
  assert.ok(!('url' in pub), 'não expõe url upstream');
  assert.ok(!('source' in pub), 'não expõe a fonte da playlist');
  assert.ok(!('primaryUrl' in pub), 'não expõe a fonte primária');
  assert.ok(!('backupUrl' in pub), 'não expõe a fonte de backup');
  assert.ok(!('urls' in pub), 'não expõe a lista de fontes');
});

test('toPublicChannel assume state=live quando ausente', () => {
  const pub = toPublicChannel({ id: 'x', name: 'Sem estado' });
  assert.equal(pub.state, 'live');
});

test('toPublicChannels mapeia em lote e tolera não-array', () => {
  assert.equal(toPublicChannels([internal]).length, 1);
  assert.deepEqual(toPublicChannels(null), []);
  assert.deepEqual(toPublicChannels(undefined), []);
});

test('channelSnapshot serializa só metadados públicos e trunca', () => {
  const snap = channelSnapshot({
    name: 'X'.repeat(400),
    logo: 'L'.repeat(700),
    category: 'C',
  });
  assert.equal(snap.name.length, 255);
  assert.equal(snap.logo.length, 512);
  assert.equal(snap.category, 'C');

  const nullSnap = channelSnapshot(null);
  assert.deepEqual(nullSnap, { name: null, logo: null, category: null });
  assert.ok(!('url' in nullSnap));
});