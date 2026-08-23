/**
 * SvenTV API - Sanitização de canais para respostas públicas
 *
 * O objeto interno do canal carrega a URL absoluta upstream (`url`) e a
 * fonte da playlist (`source`). Nenhum desses campos pode sair da API para
 * o navegador: a URL revelaria os IPs reais das origens IPTV e abriria
 * caminho para acesso direto sem passar pelo proxy.
 */

'use strict';

const PUBLIC_CHANNEL_KEYS = [
  'id',
  'name',
  'cleanName',
  'originalName',
  'tvgId',
  'logo',
  'category',
  'slug',
  'quality',
  'availability',
  'format',
  'encryption',
  'isLive',
];

/**
 * Remove campos sensíveis (url/source) de um canal.
 * @param {Object} channel
 * @returns {Object}
 */
const toPublicChannel = (channel) => {
  if (!channel || typeof channel !== 'object') return channel;
  const out = {};
  for (const key of PUBLIC_CHANNEL_KEYS) {
    if (key in channel) out[key] = channel[key];
  }
  return out;
};

/**
 * Versão em lote de toPublicChannel.
 * @param {Object[]} channels
 * @returns {Object[]}
 */
const toPublicChannels = (channels) =>
  Array.isArray(channels) ? channels.map(toPublicChannel) : [];

module.exports = { toPublicChannel, toPublicChannels };
