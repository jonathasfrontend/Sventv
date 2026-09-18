/**
 * SvenTV API — Reminder Controller ("Avise-me")
 *
 * Área pessoal: lembretes de programação do EPG. Ownership SEMPRE vindo de
 * req.user.id (nunca de ids do corpo/URL). Todas as rotas usam a guarda
 * padrão requireSessionOrApi + userLimiter. A entrega da notificação é
 * two-phase: o cliente dispara a Notification do navegador e confirma via
 * POST /:id/notified — este controller só persiste/marca estados.
 */

'use strict';

const reminderService = require('../services/reminderService');

function serialize(reminder) {
  return {
    id: reminder.id,
    channelId: reminder.channelId,
    title: reminder.title,
    startsAt: reminder.startsAt ? new Date(reminder.startsAt).toISOString() : null,
    stopAt: reminder.stopAt ? new Date(reminder.stopAt).toISOString() : null,
    notifiedAt: reminder.notifiedAt ? new Date(reminder.notifiedAt).toISOString() : null,
    createdAt: reminder.createdAt ? new Date(reminder.createdAt).toISOString() : null,
  };
}

const reminderController = {
  /**
   * POST /api/user/reminders
   * Body: { channelId, title, startsAt, stopAt? }
   */
  async create(req, res, next) {
    try {
      const reminder = await reminderService.createReminder(req.user.id, req.body);
      return res.status(201).json({
        success: true,
        data: serialize(reminder),
      });
    } catch (error) {
      return next(error);
    }
  },

  /**
   * GET /api/user/reminders?limit=&upcoming=
   * Lista os lembretes do usuário (padrão: apenas os ainda não começados).
   */
  async list(req, res, next) {
    try {
      const upcoming = req.query.upcoming === '0' || req.query.upcoming === 'false' ? false : true;
      const reminders = await reminderService.listReminders(req.user.id, {
        limit: req.query.limit,
        upcoming,
      });
      return res.status(200).json({
        success: true,
        data: reminders.map(serialize),
      });
    } catch (error) {
      return next(error);
    }
  },

  /**
   * GET /api/user/reminders/status?channelId=&startsAt=
   * Existe lembrete para (canal, início)? O player consulta para NÃO refazer
   * o botão "Avise-me" num programa já lembrado (estado salvo em Redis com
   * fallback no banco). startsAt aceita ISO 8601 ou epoch ms.
   */
  async status(req, res, next) {
    try {
      const channelId = String(req.query.channelId || '').trim();
      const raw = String(req.query.startsAt == null ? '' : req.query.startsAt).trim();
      let startsAtMs = null;
      if (/^\d+$/.test(raw)) {
        startsAtMs = Number(raw);
      } else {
        const d = new Date(raw);
        if (!Number.isNaN(d.getTime())) startsAtMs = d.getTime();
      }
      const active = await reminderService.hasActiveReminder(req.user.id, channelId, startsAtMs);
      return res.status(200).json({
        success: true,
        data: { channelId, startsAt: startsAtMs, active },
      });
    } catch (error) {
      return next(error);
    }
  },

  /**
   * DELETE /api/user/reminders/:id
   * Remove um lembrete próprio. 404 quando não existe/pertence a outro.
   */
  async remove(req, res, next) {
    try {
      await reminderService.deleteReminder(req.user.id, req.params.id);
      return res.status(200).json({ success: true });
    } catch (error) {
      return next(error);
    }
  },

  /**
   * POST /api/user/reminders/:id/notified
   * Confirma o disparo da notificação (two-phase). Idempotente.
   */
  async markNotified(req, res, next) {
    try {
      await reminderService.markNotified(req.user.id, req.params.id);
      return res.status(200).json({ success: true });
    } catch (error) {
      return next(error);
    }
  },
};

module.exports = reminderController;