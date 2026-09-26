'use strict';

const prisma = require('../prisma/client');
const M3UService = require('../services/m3uService');
const EPGService = require('../services/epgService');
const ChannelHealthService = require('../services/channelHealthService');
const ChannelStateService = require('../services/channelStateService');
const channelStateRepository = require('../repositories/channelStateRepository');
const channelHealthRepository = require('../repositories/channelHealthRepository');
const ipBlocklistRepository = require('../repositories/ipBlocklistRepository');
const IpBlocklistService = require('../services/ipBlocklistService');
const { normalizeIp } = require('../utils/ipAddress');
const playbackService = require('../services/playbackService');
const retentionService = require('../services/retentionService');
const { audit } = require('../services/auditService');
const alertService = require('../services/alertService');
const { snapshot: metricsSnapshot, inc } = require('../utils/metrics');
const logger = require('../utils/logger');
const analyticsService = require('../services/analyticsService');
const userMetricsService = require('../services/userMetricsService');
const { resolveRange } = require('../utils/analytics');
const config = require('../config/app');
const User = require('../models/User');
const { validateAvatarUrl } = require('../services/avatarService');
const { serializeAdminUser, serializeAdminUserList } = require('../utils/adminUserSerializer');
const { normalizeEmail } = require('../repositories/userRepository');
const { passwordPolicyErrors } = require('../utils/passwordPolicy');
const { streamCsv } = require('../utils/csv');

const m3uService = M3UService.getShared();
// Serviço de verificação de saúde dos canais — singleton compartilhado com o
// proxy (channelController). Na Vercel, cada lambda fria hidrata o failover
// persistido (channel_health) no cold start via app.js.
const healthService = ChannelHealthService.getShared();
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
  googleAvatarUrl: true,
  role: true,
  status: true,
  accountRestricted: true,
  restrictedReason: true,
  lastLogin: true,
  lastLoginIp: true,
  registrationIp: true,
  termsAcceptedAt: true,
  termsVersion: true,
  createdAt: true,
  updatedAt: true,
};

const getTargetUser = async (userId) =>
  prisma.user.findUnique({ where: { id: userId } });

// IPs conhecidos de um usuário (cadastro + último login), normalizados e
// deduplicados (o mesmo IP em ambas as fontes vira UMA entrada com as duas).
// `user` pode ser linha crua do Prisma ou instância do User model.
const buildUserIps = (user) => {
  const raw = [user.registrationIp, user.lastLoginIp];
  const map = new Map();
  for (const sourceIp of raw) {
    if (!sourceIp) continue;
    const ip = normalizeIp(sourceIp);
    if (!ip) continue;
    const source = sourceIp === user.registrationIp ? 'registration' : 'lastLogin';
    const entry = map.get(ip) || { ip, sources: [] };
    if (!entry.sources.includes(source)) entry.sources.push(source);
    map.set(ip, entry);
  }
  return Array.from(map.values());
};

// Resolve o IP alvo da ação admin: IP explícito (deve pertencer ao usuário)
// ou, na ausência, o IP de cadastro || último login.
const resolveUserIp = (user, rawIp) => {
  const known = buildUserIps(user).map((r) => r.ip);
  if (rawIp) {
    const ip = normalizeIp(rawIp);
    return ip && known.includes(ip) ? ip : null;
  }
  return buildUserIps(user).sort((a, b) => {
    // prioriza o de cadastro (origem da conta) quando ambos existem.
    if (a.sources.includes('registration')) return -1;
    if (b.sources.includes('registration')) return 1;
    return 0;
  })[0]?.ip || null;
};

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

/**
 * Aplica o estado administrativo de um canal (memória + canal + write-through
 * persistência + auditoria). Caminho ÚNICO usado por setChannelState e
 * bulkChannelState — o lote nunca pode divergir do single.
 */
const applyChannelState = async (channel, state, reason, req) => {
  const actor = req.user ? (req.user.email || req.user.id) : null;

  const result = channelStateService.set(channel.id, state, {
    reason,
    actor,
  });

  // Mantém o objeto em memória coerente com o estado (publicChannel e
  // player leem `channel.state`).
  channel.state = state;

  // Persistência (write-through): o estado precisa sobreviver a restart/
  // cold start e propagar entre instâncias. FAIL-OPEN — o estado em memória
  // já foi aplicado; falha de banco é logada e contada.
  if (config.channelState.persistEnabled) {
    try {
      if (state === 'live') {
        await channelStateRepository.resetState(channel.id);
      } else {
        await channelStateRepository.upsertState(channel.id, {
          state,
          reason: result.reason,
          setBy: actor,
        });
      }
    } catch (error) {
      inc('channelStatePersistenceFailures');
      logger.warn('Falha ao persistir estado de canal:' + ' ' + error.message, {
        channelId: channel.id,
        state,
      });
    }
  }

  inc('channelStateChanges');
  audit({
    action: 'admin.channel.state',
    req,
    userId: req.user?.id,
    channelId: channel.id,
    meta: { prevState: result.prevState, state, reason: result.reason || null },
  });

  return result;
};

/**
 * Guarda do último admin ativo LANÇANDO (para uso em lote): igual à versão
 * de resposta única, mas o erro carrega statusCode 422 para ser capturado
 * por item no bulk. Messagens idênticas à rota single (paridade de UX).
 */
const lastAdminActiveMessage = (action) => {
  if (action === 'block') return 'Não é possível bloquear o último admin ativo.';
  if (action === 'demote') return 'Não é possível remover o papel de administrador do último admin ativo.';
  if (action === 'delete') return 'Não é possível excluir o último admin ativo.';
  return 'Operação recusada sobre o último admin ativo.';
};

const assertNotLastActiveAdminBulk = async ({ target, action }) => {
  if (!target || target.role !== 'admin' || target.status !== 'active') return;
  if (!['block', 'demote', 'delete'].includes(action)) return;
  const activeAdmins = await countActiveAdmins();
  if (activeAdmins <= 1) {
    const err = new Error(lastAdminActiveMessage(action));
    err.statusCode = 422;
    throw err;
  }
};

/**
 * Parseia parâmetro de data de exportação (ISO ou YYYY-MM-DD). null = inválido.
 */
const parseDateParam = (value) => {
  if (!value) return null;
  const s = String(value).trim();
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * Iterador de audit_logs para exportação: paginação por CURSOR composto
 * (createdAt, id) — sem offset (evita scans crescentes) e sem buracos por
 * empate de timestamp (o dissidente `id` desempata).
 */
const AUDIT_EXPORT_PAGE = 500;
async function* iterAuditLogsCsv(from, to) {
  let last = null;
  for (;;) {
    const rows = await prisma.auditLog.findMany({
      where: {
        createdAt: { gte: from, lte: to },
        ...(last
          ? {
              OR: [
                { createdAt: { gt: last.createdAt } },
                { createdAt: last.createdAt, id: { gt: last.id } },
              ],
            }
          : null),
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: AUDIT_EXPORT_PAGE,
    });
    if (rows.length === 0) break;
    for (const r of rows) {
      yield [
        r.createdAt ? r.createdAt.toISOString() : '',
        r.action || '',
        r.email || '',
        r.userId || '',
        r.ip || '',
        r.requestId || '',
        r.channelId || '',
        r.userAgent || '',
        r.meta ? JSON.stringify(r.meta) : '',
      ];
    }
    last = rows[rows.length - 1];
  }
}

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

      if (role === 'admin') {
        // Escalada para admin = evento sensível: alerta SEMPRE (chave com
        // timestamp p/ nunca ser engolida pelo debounce). Fire-and-forget.
        alertService.notify(`admin.role_escalation:${userId}:${Date.now()}`, {
          event: 'admin.role_escalation',
          targetUserId: userId,
          targetEmail: target.email,
          changedBy: req.user?.email || null,
        });
      }

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
   * Atualiza nome, e-mail e/ou avatar do alvo (whitelist). Unicidade de
   * e-mail verificada com pré-check + catch de P2002 (corrida → 409).
   * Avatar é URL externa HTTPS validada (migração v2.0.1 — sem upload);
   * `''` limpa o avatar personalizado (volta ao Google, se houver).
   */
  async updateProfile(req, res, next) {
    try {
      const { userId } = req.params;
      const { name, email, avatar } = req.body;

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

      if (avatar !== undefined) {
        data.avatar = String(avatar).trim() === '' ? '' : await validateAvatarUrl(avatar);
        changed.push('avatar');
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

      // Trilha dedicada quando a mudança é o avatar (paridade com a rota
      // antiga de upload, removida na migração).
      if (changed.includes('avatar')) {
        audit({
          action: 'admin.user.avatar_updated',
          req,
          userId,
          email: target.email,
          meta: { by: req.user?.email },
        });
      }

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

      // Chave com timestamp: exclusões sucessivas NUNCA são engolidas pelo debounce.
      alertService.notify(`admin.user_deleted:${userId}:${Date.now()}`, {
        event: 'admin.user_deleted',
        targetUserId: userId,
        deletedEmail: target.email,
        deletedBy: req.user?.email || null,
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

      // Limpeza de failover persistido de canais removidos da M3U
      // (channel_health) — best-effort, falha não bloqueia o reload.
      if (config.health.persistEnabled) {
        try {
          const ids = m3uService.getAllChannels().map((c) => c.id);
          await channelHealthRepository.removeStale(ids);
        } catch (error) {
          logger.warn('Falha ao limpar failover de canais removidos:' + ' ' + error.message);
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
   * GET /admin/waf
   *
   * Status consolidado do WAF + OAuth Google para o painel:
   * contadores (por lambda/processo), IPs bloqueados manualmente (env
   * WAF_BLOCKED_IPS) e os eventos de segurança mais recentes persistidos
   * em audit_logs (ações `security.*`, últimas 24h agregadas + últimos 50).
   */
  async getWafStatus(req, res, next) {
    try {
      const counters = metricsSnapshot().counters;

      const blockedIps = (process.env.WAF_BLOCKED_IPS || '')
        .split(',')
        .map((ip) => ip.trim())
        .filter(Boolean);

      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

      const [recentEvents, grouped] = await Promise.all([
        prisma.auditLog
          .findMany({
            where: { action: { startsWith: 'security.' } },
            orderBy: { createdAt: 'desc' },
            take: 50,
            select: {
              id: true,
              action: true,
              ip: true,
              userAgent: true,
              requestId: true,
              createdAt: true,
            },
          })
          .catch(() => []),
        prisma.auditLog
          .groupBy({
            by: ['action'],
            where: {
              action: { startsWith: 'security.' },
              createdAt: { gte: since },
            },
            _count: { action: true },
          })
          .catch(() => []),
      ]);

      const eventCounts = {};
      for (const g of grouped) {
        eventCounts[g.action] = g._count.action;
      }

      let blockedCount = 0;
      try {
        blockedCount = await ipBlocklistRepository.countActive();
      } catch (_) { /* fail-open: mantém 0 */ }

      return res.status(200).json({
        success: true,
        data: {
          counters: {
            wafRequests: counters.wafRequests,
            wafDetected: counters.wafDetected,
            wafBlockedIp: counters.wafBlockedIp,
            wafRateLimited: counters.wafRateLimited,
            securityBlocks: counters.securityBlocks,
            ipAccessBlocked: counters.ipAccessBlocked,
            ipAccessBlocksAdmin: counters.ipAccessBlocksAdmin,
            ipAccessUnblocksAdmin: counters.ipAccessUnblocksAdmin,
            ipBlocklistCacheHits: counters.ipBlocklistCacheHits,
            ipBlocklistCacheMisses: counters.ipBlocklistCacheMisses,
            ipBlocklistFallbacks: counters.ipBlocklistFallbacks,
            ipBlocklistPersistenceFailures: counters.ipBlocklistPersistenceFailures,
          },
          ipAccess: {
            enabled: Boolean(config.ipAccess.enabled),
            blockedCount,
            cacheTtlMs: config.ipAccess.cacheTtlMs,
          },
          google: {
            login: counters['google.login'],
            register: counters['google.register'],
            userCreated: counters['google.userCreated'],
            failures: counters['google.failure'],
            loginDenied: counters['google.loginDenied'],
            registrationRejected: counters['google.registrationRejected'],
            idMismatch: counters['googleIdMismatch'],
          },
          blockedIps,
          recentEvents,
          eventCounts,
        },
      });
    } catch (error) {
      return next(error);
    }
  },

  /**
   * GET /admin/waf/ips?page=&limit=&search=&ipStatus=
   * Lista usuários com seus IPs (cadastro + último login) e o estado de
   * bloqueio por IP (blocklist WAF persistente). DTO whitelist: IPs SÓ são
   * expostos a admin (auth do router). Busca por nome/e-mail/IP.
   */
  async listWafIps(req, res, next) {
    try {
      const page = Math.max(1, Number(req.query.page || 1));
      const limit = Math.min(500, Math.max(1, Number(req.query.limit || 50)));
      const skip = (page - 1) * limit;

      const where = {};
      const search = String(req.query.search || '').trim();
      if (search) {
        where.OR = [
          { name: { contains: search, mode: 'insensitive' } },
          { email: { contains: search, mode: 'insensitive' } },
          { registrationIp: { contains: search } },
          { lastLoginIp: { contains: search } },
        ];
      }
      const ipStatus = String(req.query.ipStatus || '').trim();
      if (ipStatus === 'blocked' || ipStatus === 'unblocked') {
        // Filtro por estado de bloqueio acontece em memória (abaixo) — o
        // banco não guarda IPs numa forma correlacionável por status.
      }

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

      // Fonte de verdade do bloqueio (Postgres), independente do cache local
      // das lambdas — o painel precisa do estado GLOBAL.
      const activeRows = await ipBlocklistRepository.loadActive().catch(() => []);
      const blockedMap = new Map();
      for (const row of activeRows) {
        blockedMap.set(row.ip, {
          reason: row.reason || '',
          blockedBy: row.blockedBy || null,
          blockedAt: row.blockedAt ? new Date(row.blockedAt).toISOString() : null,
        });
      }

      let users = items.map((u) => {
        const ips = buildUserIps(u);
        const consumers = ips.map(({ ip, sources }) => ({ ip, sources, ...(blockedMap.get(ip) || {}) }));
        const anyBlocked = consumers.some((c) => Boolean(c.reason || c.blockedBy || c.blockedAt));
        return {
          id: u.id,
          name: u.name,
          email: u.email,
          role: u.role,
          status: u.status,
          accountRestricted: Boolean(u.accountRestricted),
          restrictedReason: u.restrictedReason || null,
          lastLogin: u.lastLogin,
          lastLoginIp: u.lastLoginIp || null,
          registrationIp: u.registrationIp || null,
          termsAcceptedAt: u.termsAcceptedAt,
          termsVersion: u.termsVersion,
          createdAt: u.createdAt,
          updatedAt: u.updatedAt,
          ips: consumers,
          anyIpBlocked: anyBlocked,
        };
      });

      // Filtro por estado de bloqueio (em memória, conforme decisão acima).
      if (ipStatus) {
        users = users.filter((u) => (ipStatus === 'blocked' ? u.anyIpBlocked : !u.anyIpBlocked));
      }

      let blockedCount = blockedMap.size;
      try {
        blockedCount = await ipBlocklistRepository.countActive();
      } catch (_) { /* mantém o tamanho do map */ }

      return res.status(200).json({
        success: true,
        data: { users, total: users.length, page, limit, blockedCount },
      });
    } catch (error) {
      return next(error);
    }
  },

  /**
   * PUT /admin/waf/ips/:userId/block
   * Bloqueia o IP de um usuário (blocklist WAF). Ação por IP, não por conta:
   * todos os usuários que usarem o mesmo IP são atingidos. Guardas:
   *   - IP opcional no corpo; se enviado, DEVE pertencer ao usuário alvo;
   *   - sem IP no corpo, usa registrationIp || lastLoginIp do alvo;
   *   - anti-self-lockout: bloquear o PRÓPRIO IP exige confirmSelfBlock=true.
   * Audita `admin.ip_access.block`.
   */
  async blockUserIp(req, res, next) {
    try {
      const { userId } = req.params;
      const { ip: rawIp, reason = '', confirmSelfBlock = false } = req.body;

      const target = await getTargetUser(userId);
      if (!target) return userNotFound(res);

      const ip = resolveUserIp(target, rawIp);
      if (!ip) {
        return res.status(422).json({
          success: false,
          message: rawIp
            ? 'O IP informado não pertence a este usuário.'
            : 'Este usuário não possui IP registrado (cadastro ou último login).',
        });
      }

      // Anti-self-lockout: decidido sobre o IP do próprio admin (independente
      // do alvo da rota). Exige confirmação explícita no corpo (confirm() do
      // navegador NÃO é suficiente — mesma regra de exclusão de usuário).
      const ownIps = new Set(buildUserIps(req.user).map((r) => r.ip));
      if (ownIps.has(ip) && confirmSelfBlock !== true) {
        return res.status(422).json({
          success: false,
          message: 'Você está prestes a bloquear o seu próprio IP. Confirme com "confirmSelfBlock": true.',
        });
      }

      await IpBlocklistService.getShared().block(ip, {
        reason,
        blockedBy: req.user?.email || null,
      });

      inc('ipAccessBlocksAdmin');
      audit({
        action: 'admin.ip_access.block',
        req,
        userId,
        email: target.email,
        meta: { ip, reason: reason || null, by: req.user?.email || null },
      });

      return res.status(200).json({
        success: true,
        message: `IP ${ip} bloqueado. Todos os acessos dele (incluindo cadastro/login) foram negados.`,
        data: { ip },
      });
    } catch (error) {
      return next(error);
    }
  },

  /**
   * PUT /admin/waf/ips/:userId/unblock
   * Desbloqueia o IP de um usuário. IP no corpo é opcional (deve pertencer
   * ao alvo); sem ele, desbloqueia o IP de cadastro/último login que estiver
   * ativamente bloqueado. Audita `admin.ip_access.unblock`.
   */
  async unblockUserIp(req, res, next) {
    try {
      const { userId } = req.params;
      const { ip: rawIp } = req.body;

      const target = await getTargetUser(userId);
      if (!target) return userNotFound(res);

      let ip = null;
      if (rawIp) {
        ip = resolveUserIp(target, rawIp);
        if (!ip) {
          return res.status(422).json({
            success: false,
            message: 'O IP informado não pertence a este usuário.',
          });
        }
      } else {
        // Sem IP explícito: procura um IP do usuário ativamente bloqueado.
        const known = buildUserIps(target);
        const activeRows = await ipBlocklistRepository.loadActive().catch(() => []);
        const activeSet = new Set(activeRows.map((r) => r.ip));
        const found = known.find((r) => activeSet.has(r.ip));
        ip = found ? found.ip : null;
      }

      if (!ip) {
        return res.status(422).json({
          success: false,
          message: 'Nenhum IP deste usuário está bloqueado.',
        });
      }

      await IpBlocklistService.getShared().unblock(ip, {
        unblockedBy: req.user?.email || null,
      });

      inc('ipAccessUnblocksAdmin');
      audit({
        action: 'admin.ip_access.unblock',
        req,
        userId,
        email: target.email,
        meta: { ip, by: req.user?.email || null },
      });

      return res.status(200).json({
        success: true,
        message: `IP ${ip} desbloqueado.`,
        data: { ip },
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

      const result = await applyChannelState(channel, state, reason, req);

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
   * GET /admin/metrics/users?period=week|month|quarter|semester
   *
   * Métricas agregadas de usuários (administrativas) — computadas AO VIVO
   * a partir de `users`, `watch_history` e `audit_logs`. Resposta 100%
   * agregada: nunca expõe e-mail/nome/IP de usuário individual.
   *
   * Sem `period` → week (padrão). Valor inválido → 422 (mesmo padrão do
   * irmão /metrics/analytics).
   */
  async getUserMetrics(req, res, next) {
    try {
      const period = String(req.query.period || 'week').toLowerCase();
      const data = await userMetricsService.getOverview(period);

      if (!data) {
        return res.status(422).json({
          success: false,
          message: 'Período inválido. Use week, month, quarter ou semester.',
        });
      }

      return res.status(200).json({
        success: true,
        message: 'Métricas de usuários carregadas.',
        data,
      });
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
   * POST /admin/retention/run
   * Executa manualmente a retenção de dados operacionais (request_usage +
   * audit_logs expirados). Espelho do cron interno — útil para testes e
   * picos de armazenamento. Auditoria registra o resultado.
   */
  async runRetention(req, res, next) {
    try {
      const result = await retentionService.runRetention();
      audit({
        action: 'admin.retention.run',
        req,
        userId: req.user?.id,
        meta: result,
      });
      return res.status(200).json({
        success: true,
        message: 'Retenção executada com sucesso.',
        data: result,
      });
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

  /**
   * PUT /admin/channels/bulk-state
   * Aplica estado em lote (máx. 50 canais, validado por schema). Cada item é
   * processado INDEPENDENTEMENTE — um canal inexistente ou falha pontual não
   * derruba o lote nem cancela os seguintes. Reusa o MESMO caminho do
   * `setChannelState` (applyChannelState: memória + persistência + auditoria).
   * Auditoria por item (admin.channel.state) + resumo (admin.channel.bulk_state).
   */
  async bulkChannelState(req, res, next) {
    try {
      const items = Array.isArray(req.body.items) ? req.body.items : [];
      const results = [];
      let applied = 0;

      for (const item of items) {
        try {
          const channel = m3uService.getChannelById(item.channelId);
          if (!channel) {
            results.push({
              channelId: item.channelId,
              state: item.state,
              success: false,
              error: 'Canal não encontrado.',
            });
            continue;
          }
          const result = await applyChannelState(channel, item.state, item.reason, req);
          applied += 1;
          results.push({
            channelId: item.channelId,
            state: result.state,
            prevState: result.prevState,
            reason: result.reason,
            success: true,
          });
        } catch (error) {
          results.push({
            channelId: item.channelId,
            state: item.state,
            success: false,
            error: (error && error.message) || 'Falha ao aplicar estado.',
          });
        }
      }

      audit({
        action: 'admin.channel.bulk_state',
        req,
        userId: req.user?.id,
        meta: { total: items.length, applied, failed: items.length - applied },
      });

      return res.status(200).json({
        success: true,
        message: `${applied} de ${items.length} canais atualizados.`,
        data: { results, applied, failed: items.length - applied },
      });
    } catch (error) {
      return next(error);
    }
  },

  /**
   * PUT /admin/users/bulk
   * Ações em lote sobre usuários (block/unblock/promote/demote/delete, máx.
   * 50). NUNCA contorna as proteções da rota single: cada item é submetido a
   * anti-self-lockout e à guarda do último admin ativo; exclusão exige
   * `confirm: true` por item. Processamento independente — um item falho não
   * cancela os demais.
   */
  async bulkUserActions(req, res, next) {
    try {
      const items = Array.isArray(req.body.items) ? req.body.items : [];
      const results = [];
      let applied = 0;

      for (const item of items) {
        const base = { userId: item.userId, action: item.action };
        try {
          if (item.action === 'delete' && item.confirm !== true) {
            results.push({ ...base, success: false, error: 'A exclusão precisa ser confirmada com confirm: true.' });
            continue;
          }

          const target = await getTargetUser(item.userId);
          if (!target) {
            results.push({ ...base, success: false, error: 'Usuário não encontrado.' });
            continue;
          }

          // PROTEÇÕES OBRIGATÓRIAS: self-lockout e último admin ativo.
          assertAdminWriteGuards({ actor: req.user, target, action: item.action });
          await assertNotLastActiveAdminBulk({ target, action: item.action });

          if (item.action === 'block' || item.action === 'unblock') {
            const blocked = item.action === 'block';
            const user = await prisma.user.update({
              where: { id: item.userId },
              data: {
                accountRestricted: blocked,
                restrictedReason: blocked ? (item.reason || 'Conta bloqueada por administrador') : null,
                status: blocked ? 'inactive' : 'active',
                apiTokenActive: !blocked,
                apiTokenVersion: { increment: 1 },
              },
              select: PUBLIC_USER_SELECT,
            });
            audit({
              action: blocked ? 'admin.user_block' : 'admin.user_unblock',
              req,
              userId: item.userId,
              email: target.email,
              meta: { reason: blocked ? (item.reason || null) : null, by: req.user?.email },
            });
            applied += 1;
            results.push({ ...base, success: true, status: user.status });
            continue;
          }

          if (item.action === 'promote' || item.action === 'demote') {
            const role = item.action === 'promote' ? 'admin' : 'user';
            const roleRow = await prisma.role.findUnique({ where: { code: role } });
            if (!roleRow) {
              results.push({ ...base, success: false, error: 'Role não encontrada.' });
              continue;
            }
            const user = await prisma.user.update({
              where: { id: item.userId },
              data: { role, roleId: roleRow.id },
              select: PUBLIC_USER_SELECT,
            });
            audit({
              action: 'admin.change_user_role',
              req,
              userId: item.userId,
              email: target.email,
              meta: { role, prevRole: target.role, by: req.user?.email },
            });
            if (item.action === 'promote') {
              alertService.notify(`admin.role_escalation:${item.userId}:${Date.now()}`, {
                event: 'admin.role_escalation',
                targetUserId: item.userId,
                targetEmail: target.email,
                changedBy: req.user?.email || null,
              });
            }
            applied += 1;
            results.push({ ...base, success: true, role });
            continue;
          }

          if (item.action === 'delete') {
            await prisma.user.delete({ where: { id: item.userId }, select: { id: true, email: true } });
            audit({
              action: 'admin.user.deleted',
              req,
              userId: item.userId,
              email: target.email,
              meta: { deletedEmail: target.email, by: req.user?.email },
            });
            alertService.notify(`admin.user_deleted:${item.userId}:${Date.now()}`, {
              event: 'admin.user_deleted',
              targetUserId: item.userId,
              deletedEmail: target.email,
              deletedBy: req.user?.email || null,
            });
            applied += 1;
            results.push({ ...base, success: true });
            continue;
          }

          results.push({ ...base, success: false, error: 'Ação inválida.' });
        } catch (error) {
          results.push({
            ...base,
            success: false,
            error: (error && error.message) || 'Falha ao executar ação.',
          });
        }
      }

      audit({
        action: 'admin.users.bulk',
        req,
        userId: req.user?.id,
        meta: { total: items.length, applied, failed: items.length - applied },
      });

      return res.status(200).json({
        success: true,
        message: `${applied} de ${items.length} ações executadas.`,
        data: { results, applied, failed: items.length - applied },
      });
    } catch (error) {
      return next(error);
    }
  },

  /**
   * GET /admin/export/analytics.csv?period=today|7d|30d|90d|custom&from=&to=
   * Exporta analytics em CSV (seção por canal + diária), streaming com cursor
   * no banco e escrita por linha no response. Confere auditoria
   * admin.analytics.export_csv.
   */
  async exportAnalyticsCSV(req, res, next) {
    try {
      const range = resolveRange(req.query);
      if (!range) {
        return res.status(422).json({
          success: false,
          message: 'Período inválido. Use today, 7d, 30d, 90d ou custom (from/to).',
          errors: [{ field: 'period', message: 'Período inválido' }],
        });
      }

      audit({
        action: 'admin.analytics.export_csv',
        req,
        userId: req.user?.id,
        meta: { from: range.start.toISOString(), to: range.end.toISOString() },
      });

      await analyticsService.streamAnalyticsCSV(res, range);
      return undefined;
    } catch (error) {
      // Depois que o CSV começou não há mais JSON possível — encerra o stream.
      if (res.headersSent) {
        try { res.end(); } catch (e) { /* já encerrado */ }
        return undefined;
      }
      return next(error);
    }
  },

  /**
   * GET /admin/export/audit-logs.csv?from=&to=
   * Exporta a trilha de auditoria (from/to obrigatórios, máx. 366 dias),
   * streaming com cursor composto (createdAt,id). CSV neutro contra injeção
   * de fórmula (csvCell). Confere auditoria admin.audit_logs.export_csv.
   */
  async exportAuditLogsCSV(req, res, next) {
    try {
      const from = parseDateParam(req.query.from);
      const to = parseDateParam(req.query.to);
      if (!from || !to || from.getTime() > to.getTime()) {
        return res.status(422).json({
          success: false,
          message: 'Informe parâmetros from/to válidos (from <= to).',
          errors: [
            { field: 'from', message: !from ? 'Data inválida.' : null },
            { field: 'to', message: !to ? 'Data inválida.' : null },
            { field: 'range', message: from && to && from.getTime() > to.getTime() ? 'from deve ser <= to.' : null },
          ].filter((e) => e.message),
        });
      }
      if (to.getTime() - from.getTime() > 366 * 24 * 60 * 60 * 1000) {
        return res.status(422).json({
          success: false,
          message: 'O intervalo máximo para exportação é de 366 dias.',
          errors: [{ field: 'range', message: 'Intervalo máximo de 366 dias.' }],
        });
      }

      audit({
        action: 'admin.audit_logs.export_csv',
        req,
        userId: req.user?.id,
        meta: { from: from.toISOString(), to: to.toISOString() },
      });

      await streamCsv(
        res,
        { filename: 'audit-logs.csv' },
        ['created_at', 'action', 'email', 'user_id', 'ip', 'request_id', 'channel_id', 'user_agent', 'meta'],
        iterAuditLogsCsv(from, to)
      );
      return undefined;
    } catch (error) {
      if (res.headersSent) {
        try { res.end(); } catch (e) { /* já encerrado */ }
        return undefined;
      }
      return next(error);
    }
  },
};

module.exports = adminController;
