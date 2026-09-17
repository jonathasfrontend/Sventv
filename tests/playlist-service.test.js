'use strict';

/**
 * FASE 4 — Lote 3 (playlistService): labels de canal em uma playlist
 * NUNCA são null — quando channelName (nullable no banco) falta, o
 * channelId (estável, não-sensível) vira o label; o snapshot no add
 * cai no mesmo fallback.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const prisma = require('../src/prisma/client');
const playlistService = require('../src/services/playlistService');

function withPrismaMocks(mocks, fn) {
  const saved = {};
  const setPath = (path, value) => {
    const parts = path.split('.');
    let obj = prisma;
    for (let i = 0; i < parts.length - 1; i++) obj = obj[parts[i]];
    obj[parts[parts.length - 1]] = value;
  };
  for (const [path, mock] of Object.entries(mocks || {})) setPath(path, mock);
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [path, orig] of Object.entries(saved)) setPath(path, orig);
    });
}

test('listPlaylistChannels: channelName null vira channelId (label nunca null)', async () => {
  const rows = [
    { channelId: 'ch-y_00000009_0', channelName: null, channelLogo: null, channelCategory: 'Filmes' },
    { channelId: 'ch-z_00000010_1', channelName: 'Canal Z', channelLogo: 'http://logos/z.png', channelCategory: null },
  ];
  await withPrismaMocks(
    {
      'playlist.findFirst': async () => ({ id: 'pl-1', userId: 'u-1' }),
      'playlistChannel.findMany': async () => rows,
      'playlistChannel.count': async () => rows.length,
      'auditLog.create': async () => ({}),
    },
    async () => {
      const data = await playlistService.listPlaylistChannels('u-1', 'pl-1');
      assert.equal(data.total, 2);
      assert.equal(data.items[0].name, 'ch-y_00000009_0', 'sem channelName → label = channelId');
      assert.equal(data.items[1].name, 'Canal Z', 'com channelName → label preservado');
      assert.equal(data.items[1].logo, 'http://logos/z.png');
      assert.equal(data.items[1].category, null);
    },
  );
});

test('addChannel: sem nome no snapshot, persiste channelId como channelName', async () => {
  let createData = null;
  await withPrismaMocks(
    {
      'playlist.findFirst': async () => ({ id: 'pl-1', userId: 'u-1', name: 'Favoritas' }),
      'playlistChannel.findFirst': async () => null,
      'playlistChannel.count': async () => 0,
      'playlistChannel.create': async ({ data }) => { createData = data; return { id: 'pc-1', ...data }; },
      'auditLog.create': async () => ({}),
    },
    async () => {
      await playlistService.addChannel('u-1', 'pl-1', 'ch-meta', {});
      assert.equal(createData.channelName, 'ch-meta', 'fallback do label quando o canal não tem nome');
    },
  );
});

test('addChannel: com nome no snapshot, o nome real vence', async () => {
  let createData = null;
  await withPrismaMocks(
    {
      'playlist.findFirst': async () => ({ id: 'pl-1', userId: 'u-1', name: 'Favoritas' }),
      'playlistChannel.findFirst': async () => null,
      'playlistChannel.count': async () => 0,
      'playlistChannel.create': async ({ data }) => { createData = data; return { id: 'pc-1', ...data }; },
      'auditLog.create': async () => ({}),
    },
    async () => {
      await playlistService.addChannel('u-1', 'pl-1', 'ch-meta', { name: 'Canal Real', logo: 'http://logos/r.png' });
      assert.equal(createData.channelName, 'Canal Real');
      assert.equal(createData.channelLogo, 'http://logos/r.png');
    },
  );
});