/**
 * Avatar upload service — aceita arquivo ou URL remota e envia ao Supabase Storage.
 */

'use strict';

const axios = require('axios');
const { randomUUID } = require('crypto');
const config = require('../config/app');
const { getSupabaseClient } = require('../utils/supabaseClient');

const ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/svg+xml',
]);

const MIME_EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
};

const MAX_SIZE_BYTES = 5 * 1024 * 1024; // 5MB

const ensureValidMime = (mime) => {
  if (!ALLOWED_MIME.has(mime)) {
    const err = new Error('Formato de imagem não suportado. Use JPG, PNG, WEBP, GIF ou SVG.');
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

  ensureValidMime(contentType);

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
  try {
    const response = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 10000,
      maxContentLength: MAX_SIZE_BYTES,
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
};
