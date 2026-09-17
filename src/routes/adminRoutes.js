'use strict';

const { Router } = require('express');
const multer = require('multer');
const adminController = require('../controllers/adminController');
const { requireSessionAuth, requireRole } = require('../middlewares/auth');
const { validate } = require('../middlewares/validate');
const { adminWriteLimiter } = require('../middlewares/rateLimiter');

const router = Router();
// Upload de avatar (multipart) — 5MB, mesmo limite do perfil do usuário.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

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
router.post('/users/:userId/avatar', upload.single('avatar'), adminController.uploadAvatar);
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
router.get('/metrics/history', adminController.getHistoricMetricsSeries);
router.post('/metrics/aggregate', adminController.runAggregation);
router.get('/audit-logs', adminController.getAuditLogs);

// Exportações CSV (streaming com cursor). GET → fora do adminWriteLimiter.
router.get('/export/analytics.csv', adminController.exportAnalyticsCSV);
router.get('/export/audit-logs.csv', adminController.exportAuditLogsCSV);

// Retenção de dados operacionais (manual — espelho do cron interno).
router.post('/retention/run', adminController.runRetention);

module.exports = router;