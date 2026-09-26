'use strict';

/**
 * Regressão do bug de "canais antigos" na listagem.
 *
 * Antes, `getVersion()` era um contador sobrescrito por `this.version = 0`
 * DEPOIS do load síncrono (arquivo local), e reiniciava a cada processo. Duas
 * playlists diferentes produziam o MESMO ETag em `/api/channels` → o cliente
 * recebia 304 e reaplicava a lista antiga em cache. Agora a revisão é um
 * fingerprint do CONTEÚDO, estável entre processos.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const M3UService = require('../src/services/m3uService');

// ── Helpers ───────────────────────────────────────────────────

// EXTINF e URL precisam vir intercalados (é o formato real): o parser guarda
// o canal corrente e o descarta depois de consumir a URL.
function m3u(names) {
  return ['#EXTM3U', ...names.map((n) => `#EXTINF:-1 tvg-id="${n}",${n}\nhttp://up.example/${n}.m3u8`)].join('\n');
}

// Instância isolada, sem I/O: só o que o fingerprint usa.
function makeService(sources, channels) {
  const svc = Object.create(M3UService.prototype);
  svc.channels = channels || [];
  svc.m3uFiles = sources;
  return svc;
}

function channels(...names) {
  return names.map((n, i) => ({ id: `id-${i}`, name: n, url: 'http://up.example/x.m3u8' }));
}

// ── Fingerprint ───────────────────────────────────────────────

test('fingerprint muda quando o conteúdo da lista muda', () => {
  const a = makeService(['./a.m3u'], channels('Globo', 'SBT'));
  const b = makeService(['./b.m3u'], channels('Globo', 'Record'));

  const fa = a._fingerprint();
  const fb = b._fingerprint();

  assert.notEqual(fa, fb, 'listas diferentes NÃO podem gerar o mesmo ETag');
  assert.match(fa, /^[0-9a-f]{32}$/);
});

test('fingerprint é determinístico (mesma lista, processos diferentes)', () => {
  const sources = ['./ugth6122_plus.m3u'];
  const list = channels('Globo', 'SBT', 'Band');

  assert.equal(
    makeService(sources, list.slice())._fingerprint(),
    makeService(sources, list.slice())._fingerprint(),
    'duas lambdas com a mesma M3U devem produzir o MESMO ETag'
  );
});

test('fingerprint muda com a MESMA fonte e mesmo nº de canais, mas canais diferentes', () => {
  const sources = ['./ugth6122_plus.m3u'];
  const before = makeService(sources, channels('Globo', 'SBT'));
  const after = makeService(sources, channels('Globo', 'Record'));

  assert.notEqual(before._fingerprint(), after._fingerprint());
});

test('fingerprint muda quando apenas a ordem dos canais muda', () => {
  const sources = ['./ugth6122_plus.m3u'];
  const before = makeService(sources, channels('Globo', 'SBT'));
  const after = makeService(sources, channels('SBT', 'Globo'));

  assert.notEqual(before._fingerprint(), after._fingerprint());
});

test('fingerprint NÃO expõe caminho da fonte nem host do stream', () => {
  const svc = makeService(
    ['https://s3.secreto.example/minha-lista.m3u'],
    [{ id: 'x', name: 'Canal', url: 'http://10.0.0.5:8080/live/seg.ts' }]
  );
  const fp = svc._fingerprint();

  for (const secret of ['secreto', 'minha-lista', '10.0.0.5', '8080', 'seg.ts']) {
    assert.ok(!fp.includes(secret), `fingerprint vazou "${secret}"`);
  }
});

test('fingerprint de lista vazia é válido e não colide com uma lista com canais', () => {
  const empty = makeService(['./vazio.m3u'], []);
  const one = makeService(['./vazio.m3u'], channels('Globo'));

  assert.match(empty._fingerprint(), /^[0-9a-f]{32}$/);
  assert.notEqual(empty._fingerprint(), one._fingerprint());
});

// ── getVersion ────────────────────────────────────────────────

test('getVersion devolve o fingerprint, não um contador', async () => {
  const svc = makeService(['./a.m3u'], channels('Globo'));
  svc.version = svc._fingerprint();

  assert.equal(svc.getVersion(), svc.version);
  assert.equal(typeof svc.getVersion(), 'string');
});

test('getVersion devolve string vazia antes do primeiro load (nunca 0)', () => {
  const svc = Object.create(M3UService.prototype);
  svc.version = '';

  // 0 era o bug: constante em toda requisição ⇒ ETag igual para listas diferentes.
  assert.equal(svc.getVersion(), '');
});

// ── Carregamento real ─────────────────────────────────────────

test('loadChannels preenche version com o fingerprint (não zera com load síncrono)', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-m3u-'));
  const file = path.join(dir, 'lista.m3u');
  fs.writeFileSync(file, m3u(['Canal Um', 'Canal Dois']), 'utf-8');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const svc = Object.create(M3UService.prototype);
  svc.channels = [];
  svc.m3uFiles = [file];
  svc.version = '';
  svc.stats = { totalLoaded: 0 };

  await svc.loadChannels();

  assert.equal(svc.getVersion(), svc._fingerprint());
  assert.match(svc.getVersion(), /^[0-9a-f]{32}$/);
  assert.ok(svc.channels.length > 0);
});

test('loadChannels NÃO faz append: reload não mistura lista antiga com a nova', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-m3u-'));
  const a = path.join(dir, 'a.m3u');
  const b = path.join(dir, 'b.m3u');
  fs.writeFileSync(a, m3u(['Antigo A', 'Antigo B']), 'utf-8');
  fs.writeFileSync(b, m3u(['Novo A', 'Novo B']), 'utf-8');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const svc = Object.create(M3UService.prototype);
  svc.channels = [];
  svc.m3uFiles = [a];
  svc.version = '';
  svc.stats = { totalLoaded: 0 };

  await svc.loadChannels();
  const fpAntigo = svc.getVersion();
  const totalAntigo = svc.channels.length;

  // Troca da fonte: exatamente o cenário reportado ("mudei o link da M3U").
  svc.m3uFiles = [b];
  await svc.loadChannels();

  assert.equal(svc.channels.length, totalAntigo, 'append duplicaria os canais');
  assert.notEqual(svc.getVersion(), fpAntigo, 'trocar a M3U precisa invalidar o ETag');
});
