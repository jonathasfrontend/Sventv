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

test('admin: Logs de Auditoria é uma aba própria com filtros + recarregar + exportar CSV', () => {
  // Tab dedicada existe na nav
  assert.match(ADMIN_EJS, /data-tab="audit"[^>]*>\s*<i class="ph ph-scroll"><\/i> Auditoria/);
  const auditSection = ADMIN_EJS.slice(ADMIN_EJS.indexOf('data-panel="audit"'));
  // Todos os controles de auditoria vivem DENTRO do painel da nova aba
  for (const id of ['auditActionFilter', 'auditExportFrom', 'auditExportTo', 'loadAuditBtn', 'exportAuditBtn', 'auditTableBody']) {
    assert.ok(auditSection.includes(`id="${id}"`), `'${id}' deveria estar na aba Auditoria`);
  }
  // E nenhum deles permanece na aba Métricas
  const metricsSection = ADMIN_EJS.slice(0, ADMIN_EJS.indexOf('data-panel="channels"'));
  assert.ok(!metricsSection.includes('id="loadAuditBtn"'), 'Recarregar auditoria não deve estar na aba Métricas');
  assert.ok(!metricsSection.includes('id="exportAuditBtn"'), 'Exportar CSV de auditoria não deve estar na aba Métricas');
  // JS: polling só quando a aba auditoria está aberta; activateTab mapeia a aba
  assert.match(ADMIN_JS, /tab === 'audit'/);
  assert.match(ADMIN_JS, /else if \(name === 'audit'\)/);
});

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

test('admin: seção "Métricas de Usuários" tem seletor de período + endpoint /metrics/users + kpis/sparkline', () => {
  assert.match(ADMIN_EJS, /id="userMetricsPeriod"/);
  assert.match(ADMIN_EJS, /id="loadUserMetricsBtn"/);
  assert.match(ADMIN_EJS, /id="userMetricsKpis"/);
  assert.match(ADMIN_EJS, /id="userMetricsSeries"/);
  assert.match(ADMIN_EJS, /id="userMetricsSecurity"/);
  assert.match(ADMIN_EJS, /id="userMetricsTerms"/);
  // Períodos expostos no seletor (week/month/quarter/semester)
  assert.match(ADMIN_EJS, /value="week"/);
  assert.match(ADMIN_EJS, /value="month"/);
  assert.match(ADMIN_EJS, /value="quarter"/);
  assert.match(ADMIN_EJS, /value="semester"/);
  // Frontend chama o endpoint com o período selecionado
  assert.match(ADMIN_JS, /\/api\/admin\/metrics\/users\?period=/);
});

test('admin: métricas de usuários recarregam na aba, no "Atualizar tudo" e apenas no polling da janela semana', () => {
  // disable do disparo manual (período/aba/refreshAll)
  assert.match(ADMIN_JS, /loadUserMetrics\(\)\.catch/);
  assert.match(ADMIN_JS, /loadUserMetrics\(true\)/);
  // guard de polling: só quando a aba é metrics E o período é week (mais barato)
  assert.match(ADMIN_JS, /\(userMetricsPeriod\?\.value \|\| 'week'\) === 'week'/);
});