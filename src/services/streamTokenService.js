/**
 * SvenTV API - Tokens de Playback e "Sealing" de URLs de stream
 *
 * Duas primitivas independentes:
 *
 * 1. Playback token  → JWT de CURTA duração (default 2h), emitido por canal,
 *    assinado com segredo próprio. O player nunca precisa conhecer o API
 *    token permanente do usuário.
 *
 * 2. Seal/Open       → cifra (AES-256-GCM) a URL absoluta de um sub-recurso
 *    HLS dentro de um blob opaco. O navegador recebe `?p=<blob>` e jamais
 *    consegue ler ou forjar a URL upstream — elimina tanto o vazamento da
 *    origem real no M3U8 reescrito quanto o SSRF via `?u=` arbitrário.
 */

'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('../config/app');

// ─────────────────────────────────────────────────────────────
// Chaves derivadas (zero-config segura: deriva de segredos existentes)
// ─────────────────────────────────────────────────────────────

const playbackSecret =
  process.env.JWT_PLAYBACK_SECRET ||
  crypto.createHash('sha256').update(`${config.jwtApi.secret}::playback`).digest('hex');

const sealKey = crypto
  .createHash('sha256')
  .update(`${process.env.JWT_PLAYBACK_SECRET || config.jwtApi.secret}::stream-seal`)
  .digest();

const b64url = (buf) => buf.toString('base64url');

// ─────────────────────────────────────────────────────────────
// Playback token
// ─────────────────────────────────────────────────────────────

/**
 * Emite um playback token vinculado a um único canal.
 * @param {{ id: string }} user
 * @param {string} channelId
 * @returns {{ playbackToken: string, expiresIn: number }}
 */
const issuePlaybackToken = (user, channelId) => {
  const expiresIn = config.jwtPlayback.expiresInSeconds;

  const playbackToken = jwt.sign(
    { id: user.id || user._id, ch: channelId, type: 'playback' },
    playbackSecret,
    { expiresIn }
  );

  return { playbackToken, expiresIn };
};

/**
 * Verifica um playback token. Retorna o payload decodificado ou null.
 * A validação do vínculo com o canal solicitado é feita pelo chamador.
 * @param {string} token
 * @returns {object|null}
 */
const verifyPlaybackToken = (token) => {
  try {
    const decoded = jwt.verify(token, playbackSecret);
    return decoded && decoded.type === 'playback' ? decoded : null;
  } catch {
    return null;
  }
};

// ─────────────────────────────────────────────────────────────
// Seal / Open (AES-256-GCM, stateless)
// ─────────────────────────────────────────────────────────────

/**
 * Cifra "channelId|url" num blob opaco `<iv>.<tag>.<ct>` (base64url).
 * @param {string} url - URL absoluta do sub-recurso upstream
 * @param {string} channelId - canal dono do recurso
 * @returns {string}
 */
const sealTarget = (url, channelId) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', sealKey, iv);
  const ct = Buffer.concat([cipher.update(`${channelId}|${url}`, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${b64url(iv)}.${b64url(tag)}.${b64url(ct)}`;
};

/**
 * Abre um blob selado. Falha se autenticidade/integridade não bater.
 * @param {string} sealed
 * @returns {{ channelId: string, url: string } | null}
 */
const openSealedTarget = (sealed) => {
  try {
    const [ivB64, tagB64, ctB64] = String(sealed).split('.');
    if (!ivB64 || !tagB64 || !ctB64) return null;

    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      sealKey,
      Buffer.from(ivB64, 'base64url')
    );
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));

    const plain = Buffer.concat([
      decipher.update(Buffer.from(ctB64, 'base64url')),
      decipher.final(),
    ]).toString('utf8');

    const sep = plain.indexOf('|');
    if (sep <= 0) return null;

    return { channelId: plain.slice(0, sep), url: plain.slice(sep + 1) };
  } catch {
    return null;
  }
};

module.exports = {
  issuePlaybackToken,
  verifyPlaybackToken,
  sealTarget,
  openSealedTarget,
};
