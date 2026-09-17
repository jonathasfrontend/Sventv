'use strict';

/**
 * FASE 4 — Lote 3 (dashboard realtime): o grid de trending era atualizado
 * UMA vez no init e congelava enquanto a aba ficava aberta. A dashboard
 * agora agenda loadTrending() a cada TRENDING_POLL_MS (30min, alinhado ao
 * TTL do cache server-side). Teste lê o fonte (browser-only, sem DOM no
 * runner) e verifica o contrato de polling.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DASHBOARD_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'dashboard.js'),
  'utf-8',
);

test('dashboard: trending é re-pollado a cada 30min (TRENDING_POLL_MS)', () => {
  assert.match(DASHBOARD_SRC, /const TRENDING_POLL_MS\s*=\s*30\s*\*\s*60\s*\*\s*1000;/);
  assert.match(
    DASHBOARD_SRC,
    /Realtime\.poll\(\{\s*name:\s*'dashboard-trending',\s*fn:\s*loadTrending,\s*interval:\s*TRENDING_POLL_MS\s*\}\);/,
  );
});

test('dashboard: polling pessoal (30s) permanece e startRealtime cobre ambos', () => {
  assert.match(
    DASHBOARD_SRC,
    /Realtime\.poll\(\{\s*name:\s*'dashboard-personal',\s*fn:\s*loadPersonal,\s*interval:\s*30000\s*\}\);/,
  );
  assert.match(DASHBOARD_SRC, /function startRealtime\(\) \{\r?\n/);
  assert.match(DASHBOARD_SRC, /name:\s*'dashboard-trending'/);
  // Nenhuma chamada antiga de startRealtimePersonal deve restar.
  assert.equal(DASHBOARD_SRC.includes('startRealtimePersonal'), false);
});