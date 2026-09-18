'use strict';

/**
 * Busca combinada do Guia — lógica client-side (public/js/guide-search.js).
 * O módulo é UMD: carregável via require() para testes sem navegador.
 * Semântica espelhada do servidor (src/utils/searchNormalize.js): acentos,
 * caixa, símbolos e token de horário ("20h" = hora cheia, "20h30"/"20:30" =
 * minuto exato) resolvido no relógio LOCAL do navegador.
 *
 * Datas dos programas são construídas com new Date(y,m,d,H,0,0) → LOCAL,
 * então os asserts valem em qualquer fuso de CI.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const GuideSearch = require('../public/js/guide-search.js');

// ── normalizeForSearch ────────────────────────────────────────

test('normalizeForSearch remove acentos, caixa e símbolos', () => {
  assert.equal(GuideSearch.normalizeForSearch('Jornal HOJE'), 'jornal hoje');
  assert.equal(GuideSearch.normalizeForSearch('SÃO PAULO FHD'), 'sao paulo fhd');
  assert.equal(GuideSearch.normalizeForSearch('Futebol & Samba!'), 'futebol e samba');
  assert.equal(GuideSearch.normalizeForSearch('—Globo—'), 'globo');
  assert.equal(GuideSearch.normalizeForSearch(''), '');
});

// ── splitTimeToken ────────────────────────────────────────────

test('splitTimeToken: "20h" → hora cheia; "20h30"/"20:30" → minuto exato', () => {
  const loose = GuideSearch.splitTimeToken('20h');
  assert.deepEqual(loose.time, { h: 20, m: 0, exact: false });
  assert.equal(loose.text, '');

  const exact1 = GuideSearch.splitTimeToken('20h30');
  assert.deepEqual(exact1.time, { h: 20, m: 30, exact: true });

  const exact2 = GuideSearch.splitTimeToken('20:30');
  assert.deepEqual(exact2.time, { h: 20, m: 30, exact: true });
});

test('splitTimeToken extrai token do meio da query e normaliza o resto', () => {
  const r = GuideSearch.splitTimeToken('jornal das 20h do sbt');
  assert.deepEqual(r.time, { h: 20, m: 0, exact: false });
  assert.equal(r.text, 'jornal das do sbt');
});

test('splitTimeToken: hora/minuto inválidos não viram token; sem token → texto puro', () => {
  assert.deepEqual(GuideSearch.splitTimeToken('25h').time, null);
  assert.deepEqual(GuideSearch.splitTimeToken('20:99').time, null);
  const plain = GuideSearch.splitTimeToken('cinema');
  assert.equal(plain.time, null);
  assert.equal(plain.text, 'cinema');
});

// ── matchesTimeLocal (no relógio local) ───────────────────────

function local(h, m = 0) {
  const d = new Date(2026, 8, 18, h, m, 0, 0); // setembro/2026, hora LOCAL
  return d.getTime();
}

test('matchesTimeLocal: hora cheia casa qualquer minuto da hora', () => {
  assert.equal(GuideSearch.matchesTimeLocal(local(20, 0), { h: 20, m: 0, exact: false }), true);
  assert.equal(GuideSearch.matchesTimeLocal(local(20, 59), { h: 20, m: 0, exact: false }), true);
  assert.equal(GuideSearch.matchesTimeLocal(local(21, 0), { h: 20, m: 0, exact: false }), false);
  assert.equal(GuideSearch.matchesTimeLocal(local(19, 59), { h: 20, m: 0, exact: false }), false);
});

test('matchesTimeLocal: minuto exato casa somente o instante', () => {
  assert.equal(GuideSearch.matchesTimeLocal(local(20, 30), { h: 20, m: 30, exact: true }), true);
  assert.equal(GuideSearch.matchesTimeLocal(local(20, 31), { h: 20, m: 30, exact: true }), false);
});

test('matchesTimeLocal: sem token casa toda data; data inválida → false', () => {
  assert.equal(GuideSearch.matchesTimeLocal(local(3), null), true);
  assert.equal(GuideSearch.matchesTimeLocal(NaN, { h: 10, m: 0, exact: false }), false);
});

// ── matchesGuideRow (filtro do grid) ──────────────────────────

test('matchesGuideRow: casa texto do programa (título/sinopse) ignorando acento', () => {
  const row = { name: 'Globo HD', programmes: [
    { start: new Date(local(20, 0)).toISOString(), title: 'Futebol Ação', description: 'São Paulo × Corinthians' },
  ] };
  assert.equal(GuideSearch.matchesGuideRow('futebol', row, Date.now()), true);
  assert.equal(GuideSearch.matchesGuideRow('sao paulo', row, Date.now()), true);
  assert.equal(GuideSearch.matchesGuideRow('novela', row, Date.now()), false);
});

test('matchesGuideRow: casa canal pelo nome quando a programação não casa', () => {
  const row = { cleanName: 'Globo', category: 'Aberta', programmes: [] };
  assert.equal(GuideSearch.matchesGuideRow('globo', row, Date.now()), true);
  assert.equal(GuideSearch.matchesGuideRow('aberta', row, Date.now()), true);
  assert.equal(GuideSearch.matchesGuideRow('sbt', row, Date.now()), false);
});

test('matchesGuideRow: query só de horário casa programa da hora, mesmo sem texto', () => {
  const row = { cleanName: 'SBT', programmes: [
    { start: new Date(local(20, 15)).toISOString(), title: 'Novela' },
  ] };
  assert.equal(GuideSearch.matchesGuideRow('20h', row, Date.now()), true);
  assert.equal(GuideSearch.matchesGuideRow('21h', row, Date.now()), false);
});

test('matchesGuideRow: query vazia casa tudo; linha sem info e sem tempo → false', () => {
  assert.equal(GuideSearch.matchesGuideRow('', { cleanName: 'X', programmes: [] }, Date.now()), true);
  assert.equal(GuideSearch.matchesGuideRow('20h', { cleanName: 'X', programmes: [] }, Date.now()), false);
});

// ── searchAll (painel "buscar em todos") ──────────────────────

test('searchAll: agrupa canais + programas, deduplica e ordena por start', () => {
  const channels = [
    { id: 'ch-1', cleanName: 'Globo HD', category: 'Aberta' },
    { id: 'ch-2', cleanName: 'SBT', category: 'Aberta' },
  ];
  const programmes = [
    { channelId: 'ch-1', start: new Date(local(21, 0)).toISOString(), title: 'Filme da Noite' },
    { channelId: 'ch-1', start: new Date(local(20, 0)).toISOString(), title: 'Jornal Hoje' },
    { channelId: 'ch-2', start: new Date(local(19, 30)).toISOString(), title: 'Jornal SBT' },
  ];
  const out = GuideSearch.searchAll('jornal', { channels, programmes });
  assert.deepEqual(out.channels.map((c) => c.id), []);
  assert.deepEqual(out.programmes.map((p) => p.title), ['Jornal SBT', 'Jornal Hoje']); // ordenado por hora
});

test('searchAll: token de horário filtra por hora e textos não repetem programa', () => {
  const channels = [{ id: 'ch-1', cleanName: 'Globo HD' }];
  const programmes = [
    { channelId: 'ch-1', start: new Date(local(20, 0)).toISOString(), title: 'Jornal Hoje' },
    { channelId: 'ch-1', start: new Date(local(21, 0)).toISOString(), title: 'Filme' },
  ];
  const out = GuideSearch.searchAll('20h', { channels, programmes });
  assert.deepEqual(out.programmes.map((p) => p.title), ['Jornal Hoje']);
  assert.deepEqual(out.channels, [], 'só horário não casa canais');
});