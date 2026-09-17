'use strict';

/**
 * FASE 10 — Frontend admin: os lotes de backend (CSV exports, bulk de canais
 * e bulk de usuários) ficaram sem UI. Este teste cobre o wiring do admin.ejs
 * + admin.js (browser-only, sem DOM no runner) — lê o fonte e verifica os
 * contratos de seleção em lote e exportação.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ADMIN_EJS = fs.readFileSync(path.join(__dirname, '..', 'views', 'pages', 'admin.ejs'), 'utf-8');
const ADMIN_JS = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'admin.js'), 'utf-8');

test('admin: exportação CSV está presente no painel e mira os endpoints corretos', () => {
  assert.match(ADMIN_EJS, /id="exportAnalyticsBtn"/);
  assert.match(ADMIN_EJS, /id="exportAuditBtn"/);
  assert.match(ADMIN_EJS, /id="auditExportFrom"/);
  assert.match(ADMIN_EJS, /id="auditExportTo"/);
  assert.match(ADMIN_JS, /\/api\/admin\/export\/analytics\.csv\?period=/);
  assert.match(ADMIN_JS, /\/api\/admin\/export\/audit-logs\.csv\?\$\{qs\}/);
});

test('admin: lote de canais tem checkbox por linha + barra + endpoint bulk-state', () => {
  assert.match(ADMIN_EJS, /id="chSelectAll"/);
  assert.match(ADMIN_EJS, /id="channelBulkBar"/);
  assert.match(ADMIN_EJS, /id="channelBulkState"/);
  assert.match(ADMIN_EJS, /id="channelBulkApply"/);
  assert.match(ADMIN_JS, /\/api\/admin\/channels\/bulk-state'/);
  assert.ok(!ADMIN_EJS.includes('colspan="8"'), 'colspan de canais deve ser 9 (coluna de seleção)');
  assert.match(ADMIN_JS, /colspan="9"/);
});

test('admin: lote de usuários tem seleção por card + actions (block/unblock/promote/demote/delete)', () => {
  assert.match(ADMIN_EJS, /id="userBulkBar"/);
  assert.match(ADMIN_EJS, /id="userBulkBlock"/);
  assert.match(ADMIN_EJS, /id="userBulkUnblock"/);
  assert.match(ADMIN_EJS, /id="userBulkPromote"/);
  assert.match(ADMIN_EJS, /id="userBulkDemote"/);
  assert.match(ADMIN_EJS, /id="userBulkDelete"/);
  assert.match(ADMIN_JS, /\/api\/admin\/users\/bulk'/);
  assert.match(ADMIN_JS, /data-select-user/);
  assert.match(ADMIN_JS, /confirm:\s*true/i);
});