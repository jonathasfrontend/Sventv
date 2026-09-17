/**
 * SvenTV API — Serviço de Recuperação de Senha
 *
 * Fluxo seguro:
 *  1. POST /forgot-password  → gera código de 6 dígitos, guarda APENAS o
 *     SHA-256 (nunca o código puro) e envia por e-mail. Resposta GENÉRICA
 *     idêntica para e-mail existente ou não (anti-enumeração).
 *  2. POST /reset-password   → valida e-mail + código (tempo de vida,
 *     teto de 5 tentativas, uso único atômico), redefine a senha e
 *     incrementa `session_version` (revoga TODAS as sessões do usuário,
 *     junto com a troca de senha).
 *
 * Falhas de SMTP nunca chegam ao cliente como tal — log + métrica interna.
 * Nenhum erro vaza se o e-mail existe (mensagens idênticas por design).
 *
 * Erros lançados são instâncias de `PasswordResetError` com código estável
 * para o controller traduzir em resposta genérica.
 */

'use strict';

const crypto = require('crypto');

const config = require('../config/app');
const User = require('../models/User');
const logger = require('../utils/logger');
const metrics = require('../utils/metrics');
const auditService = require('../services/auditService');
const bcrypt = require('bcryptjs');

const passwordResetCodeRepository = require('../repositories/passwordResetCodeRepository');
const emailService = require('../services/emailService');
const { passwordPolicyErrors } = require('../utils/passwordPolicy');

class PasswordResetError extends Error {
  constructor(code, message) {
    super(message || 'Não foi possível concluir a operação.');
    this.name = 'PasswordResetError';
    this.code = code;
  }
}

/**
 * SHA-256 hex do código. O único formato persistido/logável permitido.
 */
function hashCode(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex');
}

/**
 * Gera o código de 6 dígitos com CSPRNG.
 */
function generateCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

const passwordResetService = {
  /**
   * Passo 1 — solicitação de código.
   *
   * @param {{ email: string, req: object }} param
   * @returns {Promise<{ ok: true, sent: boolean }>}
   *   `sent=false` não significa e-mail inexistente: também ocorre quando o
   *   SMTP não está configurado/falhou (mesma resposta neutra).
   */
  async requestPasswordReset({ email, req }) {
    const normalizedEmail = String(email || '').trim().toLowerCase();

    // Retorna igual para qualquer e-mail — nunca diferencia existente/inexistente.
    const user = await User.findByEmail(normalizedEmail);
    if (!user) {
      metrics.inc('passwordResetRequested');
      auditService.audit({ action: 'PASSWORD_RESET_REQUESTED', req, email: normalizedEmail, meta: { found: false } });
      return { ok: true, sent: false };
    }

    metrics.inc('passwordResetRequested');

    const code = generateCode();
    const codeHash = hashCode(code);
    const expiresAt = new Date(Date.now() + config.passwordReset.codeTtlMs);

    // Apenas o código mais recente pode ser válido por usuário.
    const deleted = await passwordResetCodeRepository.deleteUnusedForUser(user.id);
    if (deleted && deleted.count > 0) {
      auditService.audit({ action: 'PASSWORD_RESET_CODE_INVALIDATED', req, userId: user.id, email: user.email, meta: { count: deleted.count } });
    }
    await passwordResetCodeRepository.create({ userId: user.id, codeHash, expiresAt });

    await auditService.audit({ action: 'PASSWORD_RESET_REQUESTED', req, userId: user.id, email: user.email, meta: { found: true } });

    try {
      await emailService.sendPasswordResetCode(user.email, code);
      await auditService.audit({ action: 'PASSWORD_RESET_CODE_SENT', req, userId: user.id, email: user.email });
      return { ok: true, sent: true };
    } catch (err) {
      metrics.inc('passwordResetSmtpFailures');
      logger.warn(`🔒 Recuperação: falha de envio de código gerado (userId=${maskId(user.id)}): ${err && err.message}`);
      await auditService.audit({ action: 'PASSWORD_RESET_SEND_FAILED', req, userId: user.id, email: user.email, meta: { reason: err.message } });
      // Cliente recebe a MESMA resposta neutra (como se o fluxo seguisse).
      return { ok: true, sent: false };
    }
  },

  /**
   * Passo 2 — redefinição com e-mail + código + nova senha.
   *
   * @param {{ email: string, code: string, newPassword: string, req: object }} param
   * @throws {PasswordResetError} sempre com mensagem/código genéricos
   */
  async resetPassword({ email, code, newPassword, req }) {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    const submittedCode = String(code || '').trim();

    // Política de senha como defesa em profundidade (a rota já valida via Joi).
    // Antes de qualquer consulta: resposta idêntica para e-mail existente ou não.
    const policyErrors = passwordPolicyErrors(newPassword);
    if (policyErrors.length) {
      metrics.inc('passwordResetFailed');
      await auditService.audit({ action: 'PASSWORD_RESET_FAILED', req, email: normalizedEmail, meta: { reason: 'weak_password' } });
      throw new PasswordResetError('INVALID_CREDENTIALS', 'Código inválido ou expirado.');
    }

    const user = await User.findByEmail(normalizedEmail);
    if (!user) {
      metrics.inc('passwordResetFailed');
      await auditService.audit({ action: 'PASSWORD_RESET_FAILED', req, email: normalizedEmail, meta: { reason: 'invalid_email' } });
      throw new PasswordResetError('INVALID_CREDENTIALS', 'Código inválido ou expirado.');
    }

    const active = await passwordResetCodeRepository.findActiveForUser(user.id);
    if (!active) {
      metrics.inc('passwordResetFailed');
      await auditService.audit({ action: 'PASSWORD_RESET_FAILED', req, userId: user.id, email: user.email, meta: { reason: 'no_active_code' } });
      throw new PasswordResetError('INVALID_CREDENTIALS', 'Código inválido ou expirado.');
    }

    const submittedHash = hashCode(submittedCode);
    const isValidCode = submittedHash === active.codeHash;

    if (isValidCode && Date.now() > new Date(active.expiresAt).getTime()) {
      metrics.inc('passwordResetExpired');
      await passwordResetCodeRepository.invalidate(active.id);
      await auditService.audit({ action: 'PASSWORD_RESET_CODE_EXPIRED', req, userId: user.id, email: user.email });
      throw new PasswordResetError('INVALID_CREDENTIALS', 'Código inválido ou expirado.');
    }

    if (!isValidCode) {
      const after = await passwordResetCodeRepository.incrementAttemptIfAllowed({
        codeId: active.id,
        maxAttempts: config.passwordReset.maxAttempts,
      });

      if (!after) {
        // Teto atingido → código invalidado (não pode mais ser tentado/validado).
        metrics.inc('passwordResetAttemptsExceeded');
        await passwordResetCodeRepository.invalidate(active.id);
        await auditService.audit({ action: 'PASSWORD_RESET_ATTEMPTS_EXCEEDED', req, userId: user.id, email: user.email });
      } else {
        metrics.inc('passwordResetFailed');
        await auditService.audit({ action: 'PASSWORD_RESET_CODE_INVALID', req, userId: user.id, email: user.email, meta: { attempts: after.attempts } });
      }

      throw new PasswordResetError('INVALID_CREDENTIALS', 'Código inválido ou expirado.');
    }

    // Código válido e não expirado. Antes de consumir, verificamos o teto atual.
    if (active.attempts >= config.passwordReset.maxAttempts) {
      metrics.inc('passwordResetAttemptsExceeded');
      await passwordResetCodeRepository.invalidate(active.id);
      await auditService.audit({ action: 'PASSWORD_RESET_ATTEMPTS_EXCEEDED', req, userId: user.id, email: user.email });
      throw new PasswordResetError('INVALID_CREDENTIALS', 'Código inválido ou expirado.');
    }

    // Código válido e não expirado em tempo e teto. Auditoria de verificação
    // bem-sucedida ANTES do consumo (não contém segredo — apenas o fato).
    await auditService.audit({ action: 'PASSWORD_RESET_CODE_VERIFIED', req, userId: user.id, email: user.email });

    const passwordHash = await bcrypt.hash(newPassword, config.security.bcryptRounds);

    // Consumo ÚNICO atômico (statement único: used_at IS NULL + attempts < max
    // + expires_at > now, no próprio UPDATE). Corridas: só uma vence.
    const { consumed, user: updatedUser } = await passwordResetCodeRepository.consumeAndSetPassword({
      codeId: active.id,
      userId: user.id,
      passwordHash,
      maxAttempts: config.passwordReset.maxAttempts,
    });

    if (consumed === 0) {
      metrics.inc('passwordResetFailed');
      await auditService.audit({ action: 'PASSWORD_RESET_FAILED', req, userId: user.id, email: user.email, meta: { reason: 'concurrent_consumption' } });
      throw new PasswordResetError('INVALID_CREDENTIALS', 'Código inválido ou expirado.');
    }

    metrics.inc('passwordResetSuccessful');
    await auditService.audit({ action: 'PASSWORD_RESET_COMPLETED', req, userId: user.id, email: user.email, meta: { sessionVersion: updatedUser.sessionVersion } });

    return { ok: true };
  },
};

/**
 * Ofusca id em logs internos (não é segredo, mas evita ruído PII em warn).
 */
function maskId(id) {
  return id && id.length > 8 ? `${id.slice(0, 4)}…${id.slice(-4)}` : 'unknown';
}

module.exports = { passwordResetService, PasswordResetError, hashCode, generateCode };