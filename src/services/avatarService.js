/**
 * SvenTV API — Serviço de Avatar (URL externa)
 *
 * Desde a migração para avatar por URL externa (v2.0.1), NÃO existe mais
 * upload de arquivo nem Supabase Storage. Este serviço apenas VALIDA a URL
 * fornecida pelo próprio usuário (ou por um admin) antes de persistir no
 * campo `avatar` do usuário:
 *
 *  - formato verificável (construtor URL nativo);
 *  - somente protocolo HTTPS (HTTP e todos os demais esquemas são recusados);
 *  - bloqueio explícito de esquemas perigosos (javascript:, data:, file:,
 *    ftp:, ws:, etc.) — javascript:/data: seriam vetores de XSS no SSR;
 *  - bloqueio de credenciais embutidas (user:pass@host) — evita phishing e
 *    vazamento de credenciais em logs/referrers;
 *  - guarda SSRF via ssrfGuard.assertSafeUrl: o host deve ser PÚBLICO
 *    (nunca IP privado/loopback/link-local/metadata/redes reservadas);
 *  - limite de tamanho da URL (2048 chars).
 *
 * IMPORTANTE: o servidor NUNCA baixa a imagem — o navegador do usuário é
 * quem carrega o recurso (a URL volta apenas em <img src> validado). A
 * validação SSRF é defesa em profundidade, caso um dia exista fetch.
 */

'use strict';

const { assertSafeUrl } = require('../utils/ssrfGuard');

const MAX_URL_LENGTH = 2048;
const ALLOWED_PROTOCOLS = new Set(['https:']);
const BLOCKED_PROTOCOLS = new Set([
  'javascript:',
  'data:',
  'file:',
  'ftp:',
  'ftps:',
  'sftp:',
  'tel:',
  'mailto:',
  'ws:',
  'wss:',
  'http:',
]);

const httpError = (message, code = 'INVALID_AVATAR_URL') => {
  const err = new Error(message);
  err.statusCode = 422;
  err.code = code;
  return err;
};

/**
 * Valida e normaliza uma URL de avatar externa.
 *
 * @param {string} imageUrl - URL HTTPS da imagem de avatar
 * @returns {Promise<string>} URL validada e normalizada
 * @throws {Error} statusCode 422 (INVALID_AVATAR_URL) ou SSRF_BLOCKED
 */
const validateAvatarUrl = async (imageUrl) => {
  const value = typeof imageUrl === 'string' ? imageUrl.trim() : '';

  if (!value) {
    throw httpError('Informe uma URL de imagem HTTPS válida.');
  }

  if (value.length > MAX_URL_LENGTH) {
    throw httpError(`A URL deve ter no máximo ${MAX_URL_LENGTH} caracteres.`);
  }

  let url;
  try {
    url = new URL(value);
  } catch (_) {
    throw httpError('URL malformada. Use o formato https://exemplo.com/imagem.png.');
  }

  const protocol = url.protocol.toLowerCase();

  if (BLOCKED_PROTOCOLS.has(protocol)) {
    throw httpError('Protocolo de URL não permitido para avatar.');
  }

  if (!ALLOWED_PROTOCOLS.has(protocol)) {
    throw httpError('Use apenas URLs HTTPS.');
  }

  if (url.username || url.password) {
    throw httpError('A URL do avatar não pode conter credenciais embutidas.');
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!hostname) {
    throw httpError('A URL do avatar deve ter um host válido.');
  }

  // Guarda SSRF: host deve resolver para endereço PÚBLICO. Lança 422 com
  // código SSRF_BLOCKED e mensagem genérica (nunca expõe o hostname).
  await assertSafeUrl(url.href);

  return url.href;
};

module.exports = {
  validateAvatarUrl,
  MAX_URL_LENGTH,
  ALLOWED_PROTOCOLS,
  BLOCKED_PROTOCOLS,
};