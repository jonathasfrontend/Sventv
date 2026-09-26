'use strict';

const { Router } = require('express');
const adminController = require('../controllers/adminController');
const { requireSessionAuth, requireRole } = require('../middlewares/auth');
const { validate } = require('../middlewares/validate');
const { adminWriteLimiter } = require('../middlewares/rateLimiter');

const router = Router();

router.use(requireSessionAuth, requireRole('admin'));

// Ações de escrita administrativa têm limiter dedicado (por admin autenticado).
// GETs (listagem/detalhe) ficam fora para não atrapalhar operações legítimas.
router.use(['post', 'put', 'delete'], adminWriteLimiter);

// ── Usuários ─────────────────────────────────────────────────
// Lote ANTES das rotas com :userId (não há conflito de match, mas a ordem
// deixa a intenção visível e impede surfamento acidental de parâmetro).
router.put('/users/bulk', validate('adminBulkUsers'), adminController.bulkUserActions);
router.get('/users', adminController.listUsers);
router.get('/users/:userId', adminController.getUser);
router.put('/users/:userId/role', validate('adminChangeRole'), adminController.changeUserRole);
router.put('/users/:userId/block', validate('adminBlockUser'), adminController.setUserBlock);
router.put('/users/:userId/profile', validate('adminUpdateProfile'), adminController.updateProfile);
router.post('/users/:userId/password', validate('adminChangePassword'), adminController.changePassword);
router.delete('/users/:userId', validate('adminDeleteUser'), adminController.deleteUser);

// ── Canais ───────────────────────────────────────────────────
// Lote de estados ANTES de /channels/:channelId/* (evita qualquer ambiguidade).
router.put('/channels/bulk-state', validate('adminBulkChannelState'), adminController.bulkChannelState);
router.get('/channels', adminController.listChannels);
router.put('/channels/:channelId/state', validate('adminChannelState'), adminController.setChannelState);
router.post('/channels/reload', adminController.reloadChannels);
router.post('/channels/:channelId/check', adminController.checkChannelHealth);
router.post('/channels/check-all', adminController.checkAllChannelsHealth);

router.get('/epg/unmatched', adminController.getEpgUnmatched);

router.get('/metrics', adminController.getMetrics);
router.get('/metrics/analytics', adminController.getAnalyticsMetrics);
router.get('/metrics/users', adminController.getUserMetrics);
router.get('/metrics/history', adminController.getHistoricMetricsSeries);
router.post('/metrics/aggregate', adminController.runAggregation);
router.get('/audit-logs', adminController.getAuditLogs);

// Status consolidado do WAF/Google para o painel (GET → sem limiter).
router.get('/waf', adminController.getWafStatus);

// ── WAF / IP Access Control ─────────────────────────────────
// Listagem (GET, sem limiter) + bloqueio/desbloqueio (PUT, adminWriteLimiter).
router.get('/waf/ips', adminController.listWafIps);
router.put('/waf/ips/:userId/block', validate('adminWafBlock'), adminController.blockUserIp);
router.put('/waf/ips/:userId/unblock', validate('adminWafUnblock'), adminController.unblockUserIp);

// Exportações CSV (streaming com cursor). GET → fora do adminWriteLimiter.
router.get('/export/analytics.csv', adminController.exportAnalyticsCSV);
router.get('/export/audit-logs.csv', adminController.exportAuditLogsCSV);

// Retenção de dados operacionais (manual — espelho do cron interno).
router.post('/retention/run', adminController.runRetention);

module.exports = router;