/**
 * SvenTV API — Serviço de lembretes de programação ("Avise-me")
 *
 * Regras de negócio concentradas aqui (o controller só traduz HTTP):
 *   - o canal SEMPRE existe na M3U (validação contra a fonte de verdade);
 *   - título é obrigatório e limitado a 255 caracteres;
 *   - startsAt precisa estar no futuro e dentro do horizonte máximo
 *     (REMINDERS_MAX_HORIZON_MS, padrão 24h a partir de "agora");
 *   - stopAt, quando informado, precisa ser posterior a startsAt;
 *   - duplicado (mesmo userId+channelId+startsAt) → erro 409 DUPLICATE;
 *   - limite por usuário (REMINDERS_MAX_PER_USER, padrão 50) → 422;
 *   - kill switch `REMINDERS_ENABLED=false` → service no-op (400 FEATURE_DISABLED),
 *     mesmo padrão de fail-closed dos demais kill switches de feature;
 *   - qualquer falha de persistência PROPAGA para o cliente (diferente do
 *     fail-open das features de streaming: lembrete é dado do usuário, ele
 *     precisa saber se não foi salvo).
 *
 * Entrega (notificação) tem DOIS canais independentes que nunca duplicam
 * (o flag `notifiedAt` pertence a quem marcar primeiro):
 *   1) frontend — browser Notification API + two-phase (dispara e confirma
 *      com markNotified); só funciona com a página aberta (limitação
 *      documentada — exige service worker, não fingido);
 *   2) servidor — runDueReminders() (cron: POST /api/internal/reminders/run,
 *      a cada 5 min na Vercel) envia e-mail SMTP para lembretes com startsAt
 *      dentro de `dueWindowMs` e marca como notificado. Se o frontend já
 *      confirmou, o e-mail não é enviado (notifiedAt setado → fora do findDue).
 * Persistência aqui é apenas o dado; nunca se envia Web Push com a página
 * fechada (limitação documentada — exige service worker), e isto NÃO é fingido.
 */

'use strict';

const config = require('../config/app');
const M3UService = require('./m3uService');
const emailService = require('./emailService');
const repository = require('../repositories/programReminderRepository');
const redisStore = require('./redisStore');
const logger = require('../utils/logger');
const { inc } = require('../utils/metrics');

const reminderService = {
  isEnabled() {
    return Boolean(config.reminders.enabled);
  },

  /**
   * Converte erro técnico em erro HTTP com código estável (mesmo padrão do
   * playlistService). Erros de validação de negócio são criados aqui.
   */
  inputError(message, statusCode = 422, code = 'VALIDATION') {
    const e = new Error(message);
    e.statusCode = statusCode;
    e.code = code;
    return e;
  },

  _assertChannel(channelId) {
    const channel = M3UService.getShared().getChannelById(channelId);
    if (!channel) {
      throw this.inputError('Canal não encontrado.', 404, 'NOT_FOUND');
    }
    return channel;
  },

  _formatHorizon(horizon) {
    const days = horizon / 86400000;
    if (Number.isInteger(days) && days > 0) {
      return days === 1 ? '1 dia' : `${days} dias`;
    }
    const hours = Math.round(horizon / 3600000);
    return `${hours}h`;
  },

  /**
   * O estado do botão "Avise-me" (não mostrar de novo para um programa já
   * lembrado) é persistido no Upstash Redis — o MESMO store dos rate/stream
   * limiters (kill switch: DISTRIBUTED_STATE_ENABLED=false desliga o marcador
   * → a busca cai direto no banco). A chave é a identidade de negócio do
   * lembrete: (userId, channelId, startsAtMs). Programa com o mesmo NOME mas
   * outro início gera outra chave → o botão reaparece e um novo lembrete é
   * armazenado (nunca reusa o estado salvo anterior).
   *
   * O marker é só um fast-path: se cache/Redis falhar ou estiver vazio, o
   * banco (findExisting) é a fonte de verdade e faz write-back.
   */
  _stateKey(userId, channelId, startsAtMs) {
    return redisStore.makeKey('rem', 'active', String(userId), String(channelId), String(Math.round(startsAtMs)));
  },

  _redisEnabled() {
    return Boolean(config.redis && config.redis.distributedEnabled);
  },

  /**
   * Grava o marcador "lembrete já ativado" para (canal, início). Fail-open:
   * Redis fora/kill switch → não lança (o banco segue sendo a verdade).
   */
  async _markStateActive(userId, channelId, startsAtMs) {
    if (!this._redisEnabled()) return false;
    const keepAfterMs = Math.max(0, Number(config.reminders.stateKeepAfterMs) || 0);
    const ttlMs = Math.max(60_000, Math.round(startsAtMs) + keepAfterMs - Date.now());
    try {
      return await redisStore.setWithTTL(this._stateKey(userId, channelId, startsAtMs), '1', ttlMs);
    } catch (_) {
      return false;
    }
  },

  /**
   * Existe lembrete para (canal, início) do usuário? Consulta feita pelo
   * player para não reexibir o botão "Avise-me" para um programa já lembrado.
   * Fast-path Redis; miss → banco + write-back best-effort.
   */
  async hasActiveReminder(userId, channelId, startsAtMs) {
    if (!this.isEnabled()) return false;
    if (!userId || !channelId) {
      throw this.inputError('Usuário e canal são obrigatórios.');
    }
    const startMs = Number(startsAtMs);
    if (!Number.isFinite(startMs) || !(startMs > 0)) {
      throw this.inputError('Data de início inválida.');
    }

    if (this._redisEnabled()) {
      try {
        const hit = await redisStore.get(this._stateKey(userId, channelId, startMs));
        if (hit) return true;
      } catch (_) {
        /* Redis fora → banco */
      }
    }

    const existing = await repository.findExisting(userId, channelId, new Date(startMs));
    if (existing) {
      // Write-back para esquentar o fast-path das próximas consultas.
      try { await this._markStateActive(userId, channelId, startMs); } catch (_) {}
      return true;
    }
    return false;
  },

  _validateWindow(startsAt, stopAt) {
    const now = Date.now();
    const horizon = Math.max(60_000, Number(config.reminders.maxHorizonMs) || 24 * 60 * 60 * 1000);

    if (!(startsAt > now)) {
      throw this.inputError('O horário do programa precisa estar no futuro.');
    }
    if (startsAt - now > horizon) {
      throw this.inputError(`Lembrete muito distante — limite de ${this._formatHorizon(horizon)} à frente.`);
    }
    if (stopAt != null && !(stopAt > startsAt)) {
      throw this.inputError('O fim do programa precisa ser posterior ao início.');
    }
  },

  _validateTitle(title) {
    const clean = String(title || '').trim().slice(0, 255);
    if (!clean) {
      throw this.inputError('O título do programa é obrigatório.');
    }
    return clean;
  },

  async createReminder(userId, { channelId, title, startsAt, stopAt }) {
    if (!this.isEnabled()) {
      throw this.inputError('Os lembretes de programação estão desativados.', 400, 'FEATURE_DISABLED');
    }
    if (!userId || !channelId) {
      throw this.inputError('Usuário e canal são obrigatórios.');
    }

    this._assertChannel(channelId);
    const cleanTitle = this._validateTitle(title);
    const start = startsAt instanceof Date ? startsAt : new Date(startsAt);
    if (!start || Number.isNaN(start.getTime())) {
      throw this.inputError('Data de início inválida.');
    }
    const stop = stopAt == null ? null : (stopAt instanceof Date ? stopAt : new Date(stopAt));
    if (stop != null && Number.isNaN(stop.getTime())) {
      throw this.inputError('Data de fim inválida.');
    }
    this._validateWindow(start.getTime(), stop ? stop.getTime() : null);

    // Duplicado → 409 (antes de qualquer escrita; UNIQUE do banco é a rede
    // de segurança final contra corridas).
    const existing = await repository.findExisting(userId, channelId, start);
    if (existing) {
      inc('remindersDuplicateRejected');
      throw this.inputError('Você já criou um lembrete para este programa.', 409, 'DUPLICATE');
    }

    const active = await repository.countActive(userId);
    if (active >= config.reminders.maxPerUser) {
      throw this.inputError(`Limite de ${config.reminders.maxPerUser} lembretes por usuário.`);
    }

    const reminder = await repository.create({
      userId,
      channelId,
      title: cleanTitle,
      startsAt: start,
      stopAt: stop,
    });
    inc('remindersCreated');
    // Estado do botão: fast-path no Redis (fail-open, nunca derruba o 201).
    try { await this._markStateActive(userId, channelId, start.getTime()); } catch (_) {}
    return reminder;
  },

  async listReminders(userId, { limit, upcoming = true, trailMs = 0 } = {}) {
    if (!this.isEnabled()) return [];
    if (!userId) return [];
    const rows = await repository.listByUser(userId, {
      limit,
      upcoming: upcoming !== false,
      trailMs: Math.max(0, Number(trailMs) || 0),
    });
    return rows;
  },

  async deleteReminder(userId, id) {
    if (!this.isEnabled()) {
      throw this.inputError('Os lembretes de programação estão desativados.', 400, 'FEATURE_DISABLED');
    }
    // Precisamos do lembrete ANTES de remover para limpar o marcador de
    // estado (a identidade do botão usa canal+início, não o id).
    const owned = await repository.findOwned(userId, id);
    if (!owned) {
      throw this.inputError('Lembrete não encontrado.', 404, 'NOT_FOUND');
    }
    const removed = await repository.remove(userId, id);
    if (!removed) {
      throw this.inputError('Lembrete não encontrado.', 404, 'NOT_FOUND');
    }
    inc('remindersDeleted');
    // Fail-open: Redis fora/kill switch → o marker expira sozinho.
    try { await redisStore.del(this._stateKey(userId, owned.channelId, Number(owned.startsAt))); } catch (_) {}
    return true;
  },

  async markNotified(userId, id) {
    if (!this.isEnabled()) {
      throw this.inputError('Os lembretes de programação estão desativados.', 400, 'FEATURE_DISABLED');
    }
    const marked = await repository.markNotified(userId, id);
    if (!marked) {
      // Pode ser: não existe, não é do usuário, ou já foi notificado (idempotente).
      const owned = await repository.findOwned(userId, id);
      if (!owned) {
        throw this.inputError('Lembrete não encontrado.', 404, 'NOT_FOUND');
      }
      // Já notificado → sucesso idempotente.
    }
    inc('remindersNotified');
    return true;
  },

  /**
   * Cron de e-mail do "Avise-me": para cada lembrete com startsAt dentro de
   * [now, now+dueWindowMs] ainda não notificado, envia o e-mail (via
   * emailProvider, default = emailService.sendReminderEmail) e NÃO marca
   * `notifiedAt` quando o envio falha — o cron seguinte re-tenta. Se o
   * frontend já notificou (two-phase), o lembrete saiu do findDue → e-mail
   * nunca disputa com a Notification do navegador.
   *
   * Falha de natureza técnica (banco fora ao listar) PROPAGA para o cron —
   * o 500 genérico do endpoint é o comportamento desejado (não mascarar).
   *
   * @param {object} [opts] injetáveis para teste/ajuste
   * @param {number} [opts.dueWindowMs] janela à frente (padrão config)
   * @param {number} [opts.batchLimit]  lote máximo por execução
   * @param {number} [opts.now]         relógio injetável (ms)
   * @param {Function} [opts.emailProvider]  (arg) -> Promise; default real
   * @param {Function} [opts.userProvider]   (userId) -> {id,email}; default prisma
   */
  async runDueReminders(opts = {}) {
    inc('reminderRuns');

    const dueWindowMs = Math.max(5_000, Number(opts.dueWindowMs) || Number(config.reminders.dueWindowMs) || 300_000);
    const batchLimit = Math.min(200, Math.max(1, Number(opts.batchLimit) || Number(config.reminders.batchLimit) || 50));
    const now = Number(opts.now) || Date.now();

    if (!this.isEnabled()) {
      return { enabled: false, examined: 0, sent: 0, failed: 0, skipped: 0, dueWindowMs, batchLimit };
    }

    // Canal de e-mail desligado (produção na Vercel Hobby usa apenas a
    // Notification do navegador) → no-op deliberado, sem tocar findDue/SMTP.
    if (config.reminders.emailEnabled === false) {
      return { enabled: true, emailEnabled: false, examined: 0, sent: 0, failed: 0, skipped: 0, dueWindowMs, batchLimit };
    }

    const emailProvider = typeof opts.emailProvider === 'function'
      ? opts.emailProvider
      : (payload) => emailService.sendReminderEmail(payload);
    const userProvider = typeof opts.userProvider === 'function'
      ? opts.userProvider
      : async (userId) => {
          const prisma = require('../prisma/client');
          return prisma.user.findUnique({
            where: { id: userId },
            select: { id: true, email: true },
          });
        };

    const rows = await repository.findDue(now, now + dueWindowMs, { limit: batchLimit });

    let sent = 0;
    let failed = 0;
    let skipped = 0;

    for (const reminder of rows) {
      try {
        const user = await userProvider(reminder.userId);
        if (!user || !user.email) {
          // Sem destino de e-mail (conta órfã/excluída) — nada a enviar.
          skipped += 1;
          continue;
        }
        const channel = M3UService.getShared().getChannelById(reminder.channelId);
        await emailProvider({
          email: user.email,
          channelName: (channel && (channel.name || channel.cleanName)) || reminder.channelId,
          programTitle: reminder.title,
          startsAt: Number(reminder.startsAt),
          stopAt: reminder.stopAt ? Number(reminder.stopAt) : null,
        });
        sent += 1;
        inc('remindersEmailsSent');
        // Best-effort idempotente: se outra lambda já marcou, nada a fazer.
        await repository.markNotifiedById(reminder.id).catch((markErr) => {
          logger.warn(`[reminderService] falha ao marcar lembrete (${reminder.id}) enviado: ${markErr && markErr.message}`);
        });
      } catch (err) {
        failed += 1;
        inc('remindersEmailFailures');
        logger.warn(`[reminderService] falha ao enviar lembrete (${reminder.id}): ${err && err.message}`);
      }
    }

    return { enabled: true, examined: rows.length, sent, failed, skipped, dueWindowMs, batchLimit };
  },
};

module.exports = reminderService;