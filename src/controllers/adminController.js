'use strict';

const prisma = require('../prisma/client');
const M3UService = require('../services/m3uService');
const ChannelHealthService = require('../services/channelHealthService');
const { audit } = require('../services/auditService');
const { snapshot: metricsSnapshot } = require('../utils/metrics');

const m3uService = M3UService.getShared();
const healthService = new ChannelHealthService(m3uService);

const adminController = {
  async listUsers(req, res, next) {
    try {
      const page = Math.max(1, Number(req.query.page || 1));
      const limit = Math.min(100, Math.max(1, Number(req.query.limit || 20)));
      const skip = (page - 1) * limit;

      const [items, total] = await Promise.all([
        prisma.user.findMany({
          skip,
          take: limit,
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
            status: true,
            accountRestricted: true,
            restrictedReason: true,
            createdAt: true,
          },
        }),
        prisma.user.count(),
      ]);

      return res.status(200).json({
        success: true,
        data: {
          users: items,
          total,
          page,
          limit,
        },
      });
    } catch (error) {
      return next(error);
    }
  },

  async changeUserRole(req, res, next) {
    try {
      const { userId } = req.params;
      const { role } = req.body;

      const roleRow = await prisma.role.findUnique({ where: { code: role } });
      if (!roleRow) {
        return res.status(404).json({ success: false, message: 'Role nao encontrada.' });
      }

      const user = await prisma.user.update({
        where: { id: userId },
        data: { role, roleId: roleRow.id },
        select: { id: true, email: true, role: true },
      });

      audit({
        action: 'admin.change_user_role',
        req,
        userId,
        meta: { role },
      });

      return res.status(200).json({
        success: true,
        message: 'Role atualizada com sucesso.',
        data: { user },
      });
    } catch (error) {
      return next(error);
    }
  },

  async setUserBlock(req, res, next) {
    try {
      const { userId } = req.params;
      const { blocked, reason } = req.body;

      const user = await prisma.user.update({
        where: { id: userId },
        data: {
          accountRestricted: Boolean(blocked),
          restrictedReason: blocked ? (reason || 'Conta bloqueada por administrador') : null,
          status: blocked ? 'inactive' : 'active',
          apiTokenActive: !blocked,
          apiTokenVersion: { increment: 1 },
        },
        select: {
          id: true,
          email: true,
          status: true,
          accountRestricted: true,
          restrictedReason: true,
        },
      });

      audit({
        action: blocked ? 'admin.user_block' : 'admin.user_unblock',
        req,
        userId,
        meta: { reason: blocked ? (reason || null) : null },
      });

      return res.status(200).json({
        success: true,
        message: blocked ? 'Conta bloqueada.' : 'Conta desbloqueada.',
        data: { user },
      });
    } catch (error) {
      return next(error);
    }
  },

  async listChannels(req, res, next) {
    try {
      const channels = m3uService.getAllChannels();
      const statuses = healthService.getStatuses();
      const statusMap = {};
      statuses.forEach(s => { statusMap[s.id] = s; });

      const categories = {};
      let online = 0;
      let unknown = 0;

      const enriched = channels.map(ch => {
        const st = statusMap[ch.id];
        const status = st ? (st.ok ? 'online' : 'offline') : 'unknown';
        if (status === 'online') online++;
        else if (status === 'unknown') unknown++;

        if (ch.category) {
          categories[ch.category] = (categories[ch.category] || 0) + 1;
        }

        return {
          id: ch.id,
          name: ch.name,
          logo: ch.logo || '',
          category: ch.category || 'Sem categoria',
          format: ch.format || 'HLS',
          quality: ch.quality || '',
          status,
          checkedAt: st ? st.checkedAt : null,
        };
      });

      return res.status(200).json({
        success: true,
        data: {
          channels: enriched,
          total: channels.length,
          online,
          offline: channels.length - online - unknown,
          unknown,
          categories: Object.keys(categories).length,
        },
      });
    } catch (error) {
      return next(error);
    }
  },

  async checkChannelHealth(req, res, next) {
    try {
      const { channelId } = req.params;
      const result = await healthService.checkChannelById(channelId);
      return res.status(200).json({
        success: true,
        data: { id: channelId, ok: result.ok, checkedAt: result.checkedAt },
      });
    } catch (error) {
      return next(error);
    }
  },

  async checkAllChannelsHealth(req, res, next) {
    try {
      await healthService.checkAllChannels();
      const statuses = healthService.getStatuses();
      let online = 0;
      statuses.forEach(s => { if (s.ok) online++; });

      audit({
        action: 'admin.check_all_channel_health',
        req,
        meta: { total: statuses.length, online },
      });

      return res.status(200).json({
        success: true,
        data: { total: statuses.length, online, offline: statuses.length - online },
      });
    } catch (error) {
      return next(error);
    }
  },

  async reloadChannels(req, res, next) {
    try {
      await m3uService.reloadChannels();

      audit({
        action: 'admin.reload_channels',
        req,
        meta: { total: m3uService.getAllChannels().length },
      });

      return res.status(200).json({
        success: true,
        message: 'Canais recarregados com sucesso.',
        data: { total: m3uService.getAllChannels().length },
      });
    } catch (error) {
      return next(error);
    }
  },

  /**
   * GET /admin/metrics
   * Métricas operacionais leves (em memória, por lambda) — saúde do proxy.
   */
  async getMetrics(req, res, next) {
    try {
      return res.status(200).json({
        success: true,
        data: metricsSnapshot(),
      });
    } catch (error) {
      return next(error);
    }
  },

  /**
   * GET /admin/audit-logs?limit=&page=&action=
   * Consulta a trilha de auditoria persistida.
   */
  async getAuditLogs(req, res, next) {
    try {
      const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
      const page = Math.max(1, Number(req.query.page) || 1);
      const skip = (page - 1) * limit;
      const where = {};
      if (req.query.action) where.action = String(req.query.action).slice(0, 80);

      const [items, total] = await Promise.all([
        prisma.auditLog.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip,
          take: limit,
        }),
        prisma.auditLog.count({ where }),
      ]);

      return res.status(200).json({
        success: true,
        data: { logs: items, total, page, limit },
      });
    } catch (error) {
      return next(error);
    }
  },
};

module.exports = adminController;
