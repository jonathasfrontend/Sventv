'use strict';

const { Router } = require('express');
const adminController = require('../controllers/adminController');
const { requireSessionAuth, requireRole } = require('../middlewares/auth');
const { validate } = require('../middlewares/validate');

const router = Router();

router.use(requireSessionAuth, requireRole('admin'));

router.get('/users', adminController.listUsers);
router.put('/users/:userId/role', validate('adminChangeRole'), adminController.changeUserRole);
router.put('/users/:userId/block', validate('adminBlockUser'), adminController.setUserBlock);

router.get('/channels', adminController.listChannels);
router.post('/channels/reload', adminController.reloadChannels);
router.post('/channels/:channelId/check', adminController.checkChannelHealth);
router.post('/channels/check-all', adminController.checkAllChannelsHealth);

router.get('/metrics', adminController.getMetrics);
router.get('/audit-logs', adminController.getAuditLogs);

module.exports = router;
