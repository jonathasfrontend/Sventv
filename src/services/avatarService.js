/**
 * Avatar upload service — aceita arquivo ou URL remota e envia ao Supabase Storage.
 *
 * Hardening desta missão (admin users):
 *  - SVG foi REMOVIDO dos formatos aceitos (rato de XSS ao servir avatar de
 *    origem não confiável — a arquitetura atual não pôde garantir um Content-
 *    Type/Disposition seguro para SVG).
 *  - Validação por MAGIC BYTES (sniffing) além do MIME declarado: o servidor
 *    confia no conteúdo, não no header do cliente.
 *  - Fetch por URL passa por guarda SSRF (`ssrfGuard.assertSafeUrl`) — só
 *    hosts públicos (IPv4/IPv6 público após resolução DNS).
 */

'use strict';

const axios = require('axios');
const { randomUUID } = require('crypto');
const config = require('../config/app');
const { getSupabaseClient } = require('../utils/supabaseClient');
const { assertSafeUrl } = require('../utils/ssrfGuard');

const ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);

const MIME_EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

const MAX_SIZE_BYTES = 5 * 1024 * 1024; // 5MB

// Detectores de magic bytes (assinatura binária real do arquivo).
const MAGIC_DETECTORS = [
  {
    mime: 'image/jpeg',
    test: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    mime: 'image/png',
    test: (b) =>
      b.length >= 8 &&
      b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
      b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a,
  },
  {
    mime: 'image/gif',
    test: (b) => b.length >= 4 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38,
  },
  {
    mime: 'image/webp',
    test: (b) =>
      b.length >= 12 &&
      String.fromCharCode(b[0], b[1], b[2], b[3]) === 'RIFF' &&
      String.fromCharCode(b[8], b[9], b[10], b[11]) === 'WEBP',
  },
];

const detectImageMime = (buffer) => {
  const found = MAGIC_DETECTORS.find((detector) => detector.test(buffer));
  return found ? found.mime : null;
};

const validateImageBuffer = (buffer, declaredMime) => {
  if (!ALLOWED_MIME.has(declaredMime)) {
    const err = new Error('Formato de imagem não suportado. Use JPG, PNG, WEBP ou GIF.');
    err.statusCode = 422;
    throw err;
  }

  const detected = detectImageMime(buffer);
  if (!detected || detected !== declaredMime) {
    const err = new Error('O conteúdo do arquivo não corresponde ao formato informado.');
    err.statusCode = 422;
    throw err;
  }
};

const buildFilePath = (userId, contentType) => {
  const ext = MIME_EXT[contentType] || 'bin';
  return `${userId}/${Date.now()}-${randomUUID()}.${ext}`;
};

const uploadBufferToSupabase = async (buffer, contentType, userId) => {
  const supabase = getSupabaseClient();

  validateImageBuffer(buffer, contentType);

  const filePath = buildFilePath(userId, contentType);

  const { error } = await supabase.storage
    .from(config.supabase.bucketAvatars)
    .upload(filePath, buffer, {
      contentType,
      upsert: true,
    });

  if (error) {
    const err = new Error(`Falha ao enviar avatar para o storage: ${error.message}`);
    err.statusCode = 500;
    throw err;
  }

  const { data } = supabase.storage.from(config.supabase.bucketAvatars).getPublicUrl(filePath);
  return data?.publicUrl;
};

const fetchImageFromUrl = async (imageUrl) => {
  // Guarda SSRF ANTES de qualquer resolução/requisição externa.
  // Lança 422 (code SSRF_BLOCKED, mensagem genérica) — nunca expõe host.
  await assertSafeUrl(imageUrl);

  try {
    const response = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 10000,
      maxContentLength: MAX_SIZE_BYTES,
      headers: { 'User-Agent': 'SvenTV-Avatar/2.0' },
    });

    const contentType = response.headers['content-type']?.split(';')[0]?.trim();
    if (!contentType) {
      const err = new Error('Não foi possível determinar o tipo da imagem remota.');
      err.statusCode = 422;
      throw err;
    }

    const buffer = Buffer.from(response.data);
    if (buffer.length > MAX_SIZE_BYTES) {
      const err = new Error('Imagem maior que 5MB. Reduza o tamanho antes de enviar.');
      err.statusCode = 422;
      throw err;
    }

    return { buffer, contentType };
  } catch (error) {
    // Erros já tipados (conteúdo/tamanho) passam adiante; falha de
    // transporte vira mensagem genérica.
    if (error && error.statusCode) throw error;

    const err = new Error('Não foi possível baixar a imagem da URL informada.');
    err.statusCode = 422;
    throw err;
  }
};

const uploadAvatar = async ({ file, imageUrl, userId }) => {
  if (!file && !imageUrl) {
    const err = new Error('Envie um arquivo ou informe uma URL de imagem.');
    err.statusCode = 422;
    throw err;
  }

  if (file && file.size > MAX_SIZE_BYTES) {
    const err = new Error('Imagem maior que 5MB.');
    err.statusCode = 422;
    throw err;
  }

  let buffer;
  let contentType;

  if (file) {
    buffer = file.buffer;
    contentType = file.mimetype;
  } else {
    const fetched = await fetchImageFromUrl(imageUrl);
    buffer = fetched.buffer;
    contentType = fetched.contentType;
  }

  return uploadBufferToSupabase(buffer, contentType, userId);
};

module.exports = {
  uploadAvatar,
  detectImageMime,
  validateImageBuffer,
  ALLOWED_MIME,
};