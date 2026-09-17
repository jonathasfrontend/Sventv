'use strict';

const prisma = require('../prisma/client');
const M3UService = require('../services/m3uService');
const EPGService = require('../services/epgService');
const ChannelHealthService = require('../services/channelHealthService');
const ChannelStateService = require('../services/channelStateService');
const channelStateRepository = require('../repositories/channelStateRepository');
const playbackService = require('../services/playbackService');
const { audit } = require('../services/auditService');
const { snapshot: metricsSnapshot, inc } = require('../utils/metrics');
const logger = require('../utils/logger');
const analyticsService = require('../services/analyticsService');
const { resolveRange } = require('../utils/analytics');
const config = require('../config/app');
const User = require('../models/User');
const { uploadAvatar } = require('../services/avatarService');
const { serializeAdminUser, serializeAdminUserList } = require('../utils/adminUserSerializer');
const { normalizeEmail } = require('../repositories/userRepository');
const { passwordPolicyErrors } = require('../utils/passwordPolicy');

const m3uService = M3UService.getShared();
const healthService = new ChannelHealthService(m3uService, {
  intervalMs: config.health.checkIntervalMs,
  requestTimeout: config.health.requestTimeoutMs,
  failoverThreshold: config.health.failoverThreshold,
  failbackMinMs: config.health.failbackMinMs,
});
const channelStateService = ChannelStateService.getShared();
const epgService = EPGService.getShared();

// ─────────────────────────────────────────────────────────────
// Helpers de gestão de usuários (admin)
// ─────────────────────────────────────────────────────────────

/**
 * Campos permitidos NA RESPOSTA do painel admin (DTO/whitelist). NUNCA
 * inclui password/apiToken/apiTokenVersion/apiTokenActive/sessionVersion/
 * loginAttempts/lockUntil — a serialização final é feita pelo serializer.
 */
const PUBLIC_USER_SELECT = {
  id: true,
  name: true,
  email: true,
  avatar: true,
  role: true,
  status: true,
  accountRestricted: true,
  restrictedReason: true,
  lastLogin: true,
  lastLoginIp: true,
  termsAcceptedAt: true,
  termsVersion: true,
  createdAt: true,
  updatedAt: true,
};

const getTargetUser = async (userId) =>
  prisma.user.findUnique({ where: { id: userId } });

const countActiveAdmins = () =>
  prisma.user.count({ where: { role: 'admin', status: 'active' } });

const isSelf = (actor, target) =>
  Boolean(actor && target && (actor.id === target.id || actor._id === target.id));

/**
 * Guarda anti-self-lockout: um admin NUNCA pode bloquear/excluir/demover a
 * própria conta (a única operação destrutiva permitida sobre si é trocar a
 * própria senha ou perfil). Documentado em RELATORIO-AUDITORIA (§20).
 */
const assertAdminWriteGuards = ({ actor, target, action }) => {
  if (['block', 'delete', 'demote'].includes(action) && isSelf(actor, target)) {
    const err = new Error('Você não pode aplicar esta ação à sua própria conta.');
    err.statusCode = 422;
    throw err;
  }
};

/**
 * Guarda do último admin ativo: bloqueio/demote/exclusão que deixaria o
 * sistema sem NENHUM admin ativo é recusado (defesa extra além do self-lock).
 */
const assertNotLastActiveAdmin = async ({ target, action, res }) => {
  if (target.role !== 'admin' || target.status !== 'active') return null;
  if (action === 'block') {
    const activeAdmins = await countActiveAdmins();
    if (activeAdmins <= 1) {
      return res.status(422).json({ success: false, message: 'Não é possível bloquear o último admin ativo.' });
    }
  }
  if (action === 'demote') {
    const activeAdmins = await countActiveAdmins();
    if (activeAdmins <= 1) {
      return res.status(422).json({ success: false, message: 'Não é possível remover o papel de administrador do último admin ativo.' });
    }
  }
  if (action === 'delete') {
    const activeAdmins = await countActiveAdmins();
    if (activeAdmins <= 1) {
      return res.status(422).json({ success: false, message: 'Não é possível excluir o último admin ativo.' });
    }
  }
  return null;
};

const userNotFound = (res) =>
  res.status(404).json({ success: false, message: 'Usuário não encontrado.' });

const adminController = {
  /**
   * GET /admin/users?page=&limit=&search=&status=
   * Lista usuários com busca (nome/e-mail, case-insensitive) e filtro de
   * status. Paginação preservada (cap 500), DTO whitelist. Sem search/status
   * mantém o contrato anterior (lista paginada completa).
   */
  async listUsers(req, res, next) {
    try {
      const page = Math.max(1, Number(req.query.page || 1));
      const limit = Math.min(500, Math.max(1, Number(req.query.limit || 100)));
      const skip = (page - 1) * limit;

      const where = {};
      const search = String(req.query.search || '').trim();
      if (search) {
        where.OR = [
          { name: { contains: search, mode: 'insensitive' } },
          { email: { contains: search, mode: 'insensitive' } },
        ];
      }
      const status = String(req.query.status || '').trim();
      if (status) where.status = status;

      const [items, total] = await Promise.all([
        prisma.user.findMany({
          where,
          skip,
          take: limit,
          orderBy: { createdAt: 'desc' },
          select: PUBLIC_USER_SELECT,
        }),
        prisma.user.count({ where }),
      ]);

      return res.status(200).json({
        success: true,
        data: {
          users: serializeAdminUserList(items),
          total,
          page,
          limit,
        },
      });
    } catch (error) {
      return next(error);
    }
  },

  /**
   * GET /admin/users/:userId
   * Detalhe completo de um usuário para a modal do painel (DTO whitelist).
   */
  async getUser(req, res, next) {
    try {
      const { userId } = req.params;
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: PUBLIC_USER_SELECT,
      });
      if (!user) return userNotFound(res);

      audit({
        action: 'admin.user.view',
        req,
        userId,
        email: user.email,
      });

      return res.status(200).json({
        success: true,
        data: { user: serializeAdminUser(user) },
      });
    } catch (error) {
      return next(error);
    }
  },

  /**
   * PUT /admin/users/:userId/role
   * Altera o papel (user/admin). Guardas: não demover a si mesmo nem o
   * último admin ativo. Audita prevRole → newRole.
   */
  async changeUserRole(req, res, next) {
    try {
      const { userId } = req.params;
      const { role } = req.body;

      const target = await getTargetUser(userId);
      if (!target) return userNotFound(res);

      const roleRow = await prisma.role.findUnique({ where: { code: role } });
      if (!roleRow) {
        return res.status(404).json({ success: false, message: 'Role não encontrada.' });
      }

      assertAdminWriteGuards({
        actor: req.user,
        target,
        action: role === 'admin' ? 'promote' : 'demote',
      });
      if (target.role === 'admin' && role === 'user') {
        const blocked = await assertNotLastActiveAdmin({ target, action: 'demote', res });
        if (blocked) return blocked;
      }

      const user = await prisma.user.update({
        where: { id: userId },
        data: { role, roleId: roleRow.id },
        select: PUBLIC_USER_SELECT,
      });

      audit({
        action: 'admin.change_user_role',
        req,
        userId,
        email: target.email,
        meta: { role, prevRole: target.role, by: req.user?.email },
      });

      return res.status(200).json({
        success: true,
        message: 'Role atualizada com sucesso.',
        data: { user: serializeAdminUser(user) },
      });
    } catch (error) {
      return next(error);
    }
  },

  /**
   * PUT /admin/users/:userId/block
   * Bloqueia/desbloqueia. Bloqueia: status→inactive, apiTokenActive=false e
   * apiTokenVersion+1 (tokens de API e sessões caem na hora). Guardas: não
   * bloquear a si mesmo nem o último admin ativo.
   */
  async setUserBlock(req, res, next) {
    try {
      const { userId } = req.params;
      const { blocked, reason } = req.body;

      const target = await getTargetUser(userId);
      if (!target) return userNotFound(res);

      assertAdminWriteGuards({
        actor: req.user,
        target,
        action: blocked ? 'block' : 'unblock',
      });
      if (blocked) {
        const blockedLast = await assertNotLastActiveAdmin({ target, action: 'block', res });
        if (blockedLast) return blockedLast;
      }

      const user = await prisma.user.update({
        where: { id: userId },
        data: {
          accountRestricted: Boolean(blocked),
          restrictedReason: blocked ? (reason || 'Conta bloqueada por administrador') : null,
          status: blocked ? 'inactive' : 'active',
          apiTokenActive: !blocked,
          apiTokenVersion: { increment: 1 },
        },
        select: PUBLIC_USER_SELECT,
      });

      audit({
        action: blocked ? 'admin.user_block' : 'admin.user_unblock',
        req,
        userId,
        email: target.email,
        meta: { reason: blocked ? (reason || null) : null, by: req.user?.email },
      });

      return res.status(200).json({
        success: true,
        message: blocked ? 'Conta bloqueada.' : 'Conta desbloqueada.',
        data: { user: serializeAdminUser(user) },
      });
    } catch (error) {
      return next(error);
    }
  },

  /**
   * PUT /admin/users/:userId/profile
   * Atualiza nome e/ou e-mail do alvo (whitelist). Unicidade de e-mail
   * verificada com pré-check + catch de P2002 (corrida → 409).
   */
  async updateProfile(req, res, next) {
    try {
      const { userId } = req.params;
      const { name, email } = req.body;

      const target = await getTargetUser(userId);
      if (!target) return userNotFound(res);

      const data = {};
      const changed = [];
      if (name !== undefined) {
        data.name = name;
        changed.push('name');
      }

      if (email !== undefined) {
        const normalized = normalizeEmail(email);
        if (normalized !== target.email) {
          const exists = await prisma.user.findUnique({ where: { email: normalized } });
          if (exists && exists.id !== userId) {
            return res.status(409).json({ success: false, message: 'Já existe uma conta com este e-mail.' });
          }
          data.email = normalized;
          changed.push('email');
        }
      }

      if (!changed.length) {
        return res.status(200).json({
          success: true,
          message: 'Nenhuma alteração foi detectada.',
          data: { user: serializeAdminUser(target) },
        });
      }

      let user;
      try {
        user = await prisma.user.update({
          where: { id: userId },
          data,
          select: PUBLIC_USER_SELECT,
        });
      } catch (error) {
        // Corrida de unicidade entre o pré-check e o update.
        if (error?.code === 'P2002') {
          return res.status(409).json({ success: false, message: 'Já existe uma conta com este e-mail.' });
        }
        throw error;
      }

      const meta = { changed, by: req.user?.email };
      if (email !== undefined) meta.emailChangedTo = normalizeEmail(email);

      audit({
        action: 'admin.user.profile_updated',
        req,
        userId,
        email: target.email,
        meta,
      });

      return res.status(200).json({
        success: true,
        message: 'Perfil atualizado com sucesso.',
        data: { user: serializeAdminUser(user) },
      });
    } catch (error) {
      return next(error);
    }
  },

  /**
   * POST /admin/users/:userId/password
   * Redefine a senha de um usuário (não exige a senha atual deles — o
   * administrador autenticado é suficiente). Bump de sessionVersion revoga
   * TODAS as sessões do alvo. O API token é preservado (segredo próprio).
   */
  async changePassword(req, res, next) {
    try {
      const { userId } = req.params;
      const { newPassword } = req.body;

      const target = await getTargetUser(userId);
      if (!target) return userNotFound(res);

      // Política de senha como defesa em profundidade (a rota já valida via Joi).
      const policyErrors = passwordPolicyErrors(newPassword);
      if (policyErrors.length) {
        const err = new Error(policyErrors[0]);
        err.statusCode = 422;
        throw err;
      }

      const updated = await User.updatePassword(userId, newPassword);
      if (!updated) return userNotFound(res);

      // Revoga todas as sessões ativas do alvo (logout em todos os dispositivos).
      await User.bumpSessionVersion(userId);

      audit({
        action: 'admin.user.password_changed',
        req,
        userId,
        email: target.email,
        meta: { by: req.user?.email },
      });

      return res.status(200).json({
        success: true,
        message: 'Senha redefinida com sucesso. As sessões do usuário foram encerradas.',
      });
    } catch (error) {
      return next(error);
    }
  },

  /**
   * POST /admin/users/:userId/avatar
   * Upload do avatar (multipart `avatar` OU campo `imageUrl`). Reusa o
   * avatarService (magic bytes + SSRF guard) e gravita o caminho no storage
   * por `userId` do alvo.
   */
  async uploadAvatar(req, res, next) {
    try {
      const { userId } = req.params;

      const target = await getTargetUser(userId);
      if (!target) return userNotFound(res);

      if (!req.file && !req.body?.imageUrl) {
        return res.status(422).json({ success: false, message: 'Envie um arquivo ou informe uma URL de imagem.' });
      }

      const avatarUrl = await uploadAvatar({
        file: req.file,
        imageUrl: req.body?.imageUrl,
        userId: target.id,
      });

      const user = await prisma.user.update({
        where: { id: userId },
        data: { avatar: avatarUrl },
        select: PUBLIC_USER_SELECT,
      });

      audit({
        action: 'admin.user.avatar_updated',
        req,
        userId,
        email: target.email,
        meta: { by: req.user?.email },
      });

      return res.status(200).json({
        success: true,
        message: 'Avatar atualizado com sucesso.',
        data: { avatar: avatarUrl, user: serializeAdminUser(user) },
      });
    } catch (error) {
      return next(error);
    }
  },

  /**
   * DELETE /admin/users/:userId
   * Exclusão permanente (exige `{ confirm: true }` no corpo — nunca apenas
   * `confirm()` no navegador). Cascatas removem dados relacionados; a trilha
   * de auditoria SOBREVIVE (audit_logs não tem FK). Guardas: não excluir a
   * si mesmo nem o último admin ativo.
   */
  async deleteUser(req, res, next) {
    try {
      const { userId } = req.params;
      const { confirm } = req.body;

      if (confirm !== true) {
        return res.status(422).json({ success: false, message: 'A exclusão precisa ser confirmada.' });
      }

      const target = await getTargetUser(userId);
      if (!target) return userNotFound(res);

      assertAdminWriteGuards({ actor: req.user, target, action: 'delete' });
      if (target.role === 'admin' && target.status === 'active') {
        const blocked = await assertNotLastActiveAdmin({ target, action: 'delete', res });
        if (blocked) return blocked;
      }

      const deleted = await prisma.user.delete({
        where: { id: userId },
        select: { id: true, email: true },
      });

      audit({
        action: 'admin.user.deleted',
        req,
        userId,
        email: target.email,
        meta: { deletedEmail: target.email, by: req.user?.email },
      });

      return res.status(200).json({
        success: true,
        message: 'Conta excluída permanentemente.',
        data: { id: deleted?.id || userId },
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

      const enriched = await Promise.all(
        channels.map(async (ch) => {
          const st = statusMap[ch.id];
          const status = st ? (st.ok ? 'online' : 'offline') : 'unknown';
          if (status === 'online') online++;
          else if (status === 'unknown') unknown++;

          if (ch.category) {
            categories[ch.category] = (categories[ch.category] || 0) + 1;
          }

          // Read-through do estado (cache curto + Postgres) — nunca lança.
          const stateEntry = await channelStateService.entry(ch.id);
          const channelState = await channelStateService.get(ch.id);

          return {
            id: ch.id,
            name: ch.name,
            logo: ch.logo || '',
            category: ch.category || 'Sem categoria',
            format: ch.format || 'HLS',
            quality: ch.quality || '',
            status,
            checkedAt: st ? st.checkedAt : null,
            // Estado administrativo + failover
            state: channelState,
            stateReason: stateEntry ? stateEntry.reason : null,
            stateUpdatedAt: stateEntry ? stateEntry.updatedAt : null,
            activeSource: st ? st.activeSource : 'primary',
            hasBackup: Boolean(ch.backupUrl),
            failoverBackupOk: st && st.backup ? st.backup.ok : null,
          };
        })
      );

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
      // A lista M3U alimenta o matching EPG — recalcula o casamento logo
      // após um reload (sem bloqueio: EPG vazio mantém guia com 0 canais).
      epgService.rebuildMatching();

      // Limpeza de estados órfãos: canais removidos da M3U não devem manter
      // estado persistido (blocked/maintenance) nem esconder o estado na
      // próxima hidratação. Best-effort — falha não bloqueia o reload.
      if (config.channelState.persistEnabled) {
        try {
          const ids = m3uService.getAllChannels().map((c) => c.id);
          await channelStateRepository.removeStale(ids);
        } catch (error) {
          logger.warn('Falha ao limpar estados de canais removidos:' + ' ' + error.message);
        }
      }

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
   * GET /admin/epg/unmatched
   * Relatório de matching EPG ↔ M3U (canais em um lado sem par no outro).
   * Não expõe a EPG_URL nem qualquer origem de stream.
   */
  async getEpgUnmatched(req, res, next) {
    try {
      await epgService.ensureLoaded();
      const report = epgService.getUnmatchedReport();

      audit({
        action: 'admin.epg.unmatched_view',
        req,
        meta: {
          totalEpg: report.totalEpg,
          totalM3u: report.totalM3u,
          matched: report.matched,
        },
      });

      return res.status(200).json({
        success: true,
        data: report,
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
      const liveViewers = await playbackService
        .getActiveViewersByChannel()
        .catch(() => ({ total: 0, channels: [] }));

      return res.status(200).json({
        success: true,
        data: {
          ...metricsSnapshot(),
          liveControl: liveViewers,
        },
      });
    } catch (error) {
      return next(error);
    }
  },

  /**
   * PUT /admin/channels/:channelId/state
   * Define o estado administrativo do canal (live | maintenance | blocked).
   * Aplicado em memória e sincronizado no objeto do canal; o gating de
   * /stream, /proxy e /playback consulta este estado.
   */
  async setChannelState(req, res, next) {
    try {
      const { channelId } = req.params;
      const { state, reason } = req.body;

      const channel = m3uService.getChannelById(channelId);
      if (!channel) {
        return res.status(404).json({ success: false, message: 'Canal não encontrado.' });
      }

      const actor = req.user ? (req.user.email || req.user.id) : null;

      const result = channelStateService.set(channelId, state, {
        reason,
        actor,
      });

      // Mantém o objeto em memória coerente com o estado (publicChannel e
      // player leem `channel.state`).
      channel.state = state;

      // Persistência (write-through): o estado precisa sobreviver a restart/
      // cold start e propagar entre instâncias. FAIL-OPEN — o estado em
      // memória já foi aplicado; falha de banco é logada e contada, a
      // resposta continua sendo sucesso (estado continua valendo nesta
      // instância até a fonte voltar).
      if (config.channelState.persistEnabled) {
        try {
          if (state === 'live') {
            await channelStateRepository.resetState(channelId);
          } else {
            await channelStateRepository.upsertState(channelId, {
              state,
              reason: result.reason,
              setBy: actor,
            });
          }
        } catch (error) {
          inc('channelStatePersistenceFailures');
          logger.warn('Falha ao persistir estado de canal:' + ' ' + error.message, {
            channelId,
            state,
          });
        }
      }

      inc('channelStateChanges');
      audit({
        action: 'admin.channel.state',
        req,
        userId: req.user?.id,
        channelId,
        meta: { prevState: result.prevState, state, reason: result.reason || null },
      });

      return res.status(200).json({
        success: true,
        message: state === 'live'
          ? 'Canal reativado.'
          : (state === 'maintenance' ? 'Canal colocado em manutenção.' : 'Canal bloqueado.'),
        data: {
          id: channelId,
          state: result.state,
          prevState: result.prevState,
          reason: result.reason,
          updatedAt: result.updatedAt,
        },
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

  /**
   * GET /admin/metrics/analytics?period=today|7d|30d|90d|custom&from=&to=
   *
   * Métricas de analytics (overview, canais, categorias, usuários, série).
   * Computadas AO VIVO a partir de playback_sessions — dados nunca são
   * duplo-contados.
   *
   * Efeitos colaterais oportunistas (sem bloquear a resposta):
   *  - popula as tabelas diárias ChannelMetric/UserMetric (períodos
   *    longos), alimentando a retenção de longa duração;
   *  - roda a retenção probabilística de eventos/sessões antigos.
   */
  async getAnalyticsMetrics(req, res, next) {
    try {
      const query = req.query;
      const range = resolveRange(query);
      if (!range) {
        return res.status(422).json({
          success: false,
          message: 'Período inválido. Use today, 7d, 30d, 90d ou custom (from/to).',
        });
      }

      // Retenção oportunista (fire-and-forget; falhas são logadas pelo serviço).
      analyticsService.runRetention().catch(() => {});

      // Agregação diária sob demanda para períodos > hoje (popula as
      // tabelas de retenção sem bloquear a resposta do usuário).
      const isLong = ['30d', '90d', 'custom'].includes(String(query.period || '').toLowerCase());
      if (isLong) {
        analyticsService
          .ensureAggregated(range, { maxDays: 35 })
          .catch(() => {});
      }

      const data = await analyticsService.getAdminMetrics(query);
      return res.status(200).json({ success: true, data });
    } catch (error) {
      return next(error);
    }
  },

  /**
   * POST /admin/metrics/aggregate
   * Backfill manual das tabelas diárias (ChannelMetric/UserMetric) para
   * um range máximo de 90 dias. Útil para popular histórico/resgate.
   */
  async runAggregation(req, res, next) {
    try {
      const range = resolveRange(req.query || req.body || {});
      if (!range) {
        return res.status(422).json({
          success: false,
          message: 'Período inválido. Use today, 7d, 30d, 90d ou custom (from/to).',
        });
      }
      const { days } = await analyticsService.ensureAggregated(range, { maxDays: 90 });
      audit({ action: 'admin.analytics.aggregate', req, userId: req.user?.id, meta: { days } });
      return res.status(200).json({ success: true, data: { days } });
    } catch (error) {
      return next(error);
    }
  },

  /**
   * GET /admin/metrics/history?period=90d|custom
   * Série histórica de longa duração lida das tabelas diárias agregadas
   * (evita recontar cada sessão para 90+ dias).
   */
  async getHistoricMetricsSeries(req, res, next) {
    try {
      const range = resolveRange(req.query);
      if (!range) {
        return res.status(422).json({
          success: false,
          message: 'Período inválido. Use 90d ou custom (from/to).',
        });
      }
      const series = await analyticsService.getHistoricalSeries(req.query);
      return res.status(200).json({ success: true, data: { series } });
    } catch (error) {
      return next(error);
    }
  },
};

module.exports = adminController;
