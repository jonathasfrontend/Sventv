'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const ChannelHealthService = require('../src/services/channelHealthService');

const channel = {
  id: 'ch1',
  url: 'http://primary.example/1.m3u8',
  primaryUrl: 'http://primary.example/1.m3u8',
  backupUrl: 'http://backup.example/1.m3u8',
  urls: ['http://primary.example/1.m3u8', 'http://backup.example/1.m3u8'],
};

// Sem m3uService no construtor para NÃO iniciar o ciclo automático (que
// manteria timers vivos nos testes). O serviço é injetado depois para os
// métodos que o consultam (reportResult).
function makeHealth(state) {
  const svc = new ChannelHealthService(null, {
    intervalMs: 1000,
    requestTimeout: 100,
    failoverThreshold: 2,
    failbackMinMs: 0,
    minSwitchMs: 0,
    // Unit test puro em memória: sem persistência (transições NÃO tocam o
    // Postgres aqui — o contrato de persistência vive em channel-health-
    // persistence.test.js com repos/temps fake).
    persistEnabled: false,
  });
  svc.m3uService = {
    getAllChannels: () => [channel],
    getChannelById: (id) => (id === channel.id ? channel : null),
  };
  svc._checkUrl = async (url) => {
    if (url === channel.url) return state.primary;
    if (url === channel.backupUrl) return state.backup;
    return false;
  };
  return svc;
}

test('resolveSourceUrls devolve a primária primeiro por padrão', () => {
  const svc = makeHealth({ primary: true, backup: true });
  assert.deepEqual(svc.resolveSourceUrls(channel), [channel.url, channel.backupUrl]);
  assert.equal(svc.resolveActiveUrl(channel), channel.url);
});

test('failover só ocorre após o threshold de falhas consecutivas', async () => {
  const svc = makeHealth({ primary: false, backup: true });

  await svc.checkChannel(channel); // 1ª falha
  assert.equal(svc.getFailoverInfo('ch1').activeSource, 'primary');

  await svc.checkChannel(channel); // 2ª falha → failover
  assert.equal(svc.getFailoverInfo('ch1').activeSource, 'backup');
  assert.equal(svc.resolveActiveUrl(channel), channel.backupUrl);
  assert.deepEqual(svc.resolveSourceUrls(channel), [channel.backupUrl, channel.url]);
});

test('failback volta à primária quando ela responde e o backup falha', async () => {
  const svc = makeHealth({ primary: false, backup: true });
  await svc.checkChannel(channel);
  await svc.checkChannel(channel);
  assert.equal(svc.getFailoverInfo('ch1').activeSource, 'backup');

  svc._checkUrl = async (url) => url === channel.url; // primária ok, backup down
  await svc.checkChannel(channel);
  assert.equal(svc.getFailoverInfo('ch1').activeSource, 'primary');
  assert.equal(svc.resolveActiveUrl(channel), channel.url);
});

test('canal sem backup nunca sai da primária', async () => {
  const solo = {
    id: 'solo',
    url: 'http://only.example/1.m3u8',
    primaryUrl: 'http://only.example/1.m3u8',
    urls: ['http://only.example/1.m3u8'],
  };
  const svc = new ChannelHealthService(null, { minSwitchMs: 0, failoverThreshold: 1 });
  svc._checkUrl = async () => false;

  await svc.checkChannel(solo);
  await svc.checkChannel(solo);
  assert.equal(svc.getFailoverInfo('solo').activeSource, 'primary');
});

test('getStatuses reflete a fonte ativa em ok/checkedAt', async () => {
  const svc = makeHealth({ primary: false, backup: true });
  await svc.checkChannel(channel);
  await svc.checkChannel(channel);

  const [st] = svc.getStatuses();
  assert.equal(st.id, 'ch1');
  assert.equal(st.activeSource, 'backup');
  assert.equal(st.ok, true);
  assert.equal(st.primary.ok, false);
  assert.equal(st.backup.ok, true);
});

test('reportResult registra resultado sem trocar de fonte', () => {
  const svc = makeHealth({ primary: true, backup: true });
  svc.reportResult('ch1', channel.url, false);

  const info = svc.getFailoverInfo('ch1');
  assert.equal(info.activeSource, 'primary');
  assert.equal(info.fails.primary, 1);
});
