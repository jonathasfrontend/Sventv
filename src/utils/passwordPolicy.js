/**
 * SvenTV API — Política de Senha (fonte única)
 *
 * Regras aplicadas em TODAS as entradas de senha (registro, troca e
 * redefinição). Centralizar aqui evita divergência entre Joi e serviços.
 *
 * Lembrete crítico do bcrypt: o hash trunca a entrada em 72 BYTES. Como
 * senhas Unicode podem estourar 72 bytes antes de 72 caracteres, a validação
 * de tamanho é feita em bytes (Buffer.byteLength, UTF-8) e NUNCA em
 * quantidade de caracteres. Sem isso, duas senhas diferentes poderiam virar
 * o mesmo hash (colisão real por truncamento).
 */

'use strict';

const config = require('../config/app');

const MIN_LENGTH = config.security.passwordMinLength;
const MAX_BYTES = config.security.passwordMaxBytes;

/**
 * Valida a senha contra a política. Retorna array de mensagens de erro
 * (vazio quando a senha é aceita). Fonte da verdade no backend.
 *
 * @param {string} password
 * @returns {string[]}
 */
function passwordPolicyErrors(password) {
  const errors = [];

  if (typeof password !== 'string' || password.length === 0) {
    errors.push('A senha é obrigatória.');
    return errors;
  }

  if (Buffer.byteLength(password, 'utf8') > MAX_BYTES) {
    errors.push(`A senha deve ter no máximo ${MAX_BYTES} bytes (limite do bcrypt).`);
    return errors;
  }

  if (password.length < MIN_LENGTH) {
    errors.push(`A senha deve ter pelo menos ${MIN_LENGTH} caracteres.`);
  }
  if (!/[a-z]/.test(password)) {
    errors.push('A senha deve conter pelo menos uma letra minúscula.');
  }
  if (!/[A-Z]/.test(password)) {
    errors.push('A senha deve conter pelo menos uma letra maiúscula.');
  }
  if (!/[0-9]/.test(password)) {
    errors.push('A senha deve conter pelo menos um número.');
  }

  return errors;
}

/**
 * Apenas boolean: senha aceita ou não.
 */
function isValidPassword(password) {
  return passwordPolicyErrors(password).length === 0;
}

/**
 * Check de byte-length útil para os `.custom()` do Joi (mensagem agnóstica
 * de idioma de nível de validação — a mensagem real vem de passwordPolicyErrors).
 */
function exceedsBcryptLimit(password) {
  return typeof password === 'string' && Buffer.byteLength(password, 'utf8') > MAX_BYTES;
}

module.exports = {
  MIN_LENGTH,
  MAX_BYTES,
  passwordPolicyErrors,
  isValidPassword,
  exceedsBcryptLimit,
};