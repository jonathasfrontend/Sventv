/**
 * SvenTV API — Playlist Service
 *
 * Gerencia playlists personalizadas do usuário.
 *
 * REGRA CRÍTICA: um canal só pode pertencer a UMA playlist por usuário.
 * A garantia é dupla:
 *  1. Banco: UNIQUE(userId, channelId) em playlist_channels (userId é
 *     denormalizado na tabela para que a constraint transcenda a playlist).
 *  2. Serviço: pré-checagem + captura de P2002 (corrida) retornando 409
 *     com a playlist onde o canal já está salvo.
 *
 * Condições de corrida (duas requisições simultâneas adicionando o mesmo
 * canal a playlists diferentes): a constraint do banco rejeita a segunda;
 * não há janela de inconsistência.
 */

'use strict';

const prisma = require('../prisma/client');
const config = require('../config/app');
const { inc } = require('../utils/metrics');
const { bigToNumber } = require('../utils/analytics');

const InputError = (message, statusCode = 422, code = 'VALIDATION') => {
  const e = new Error(message);
  e.statusCode = statusCode;
  e.code = code;
  return e;
};

const channelSnapshot = (channel, channelIdFallback = null) => {
  if (!channel) return { name: channelIdFallback, logo: null, category: null };
  return {
    name: channel.name ? String(channel.name).slice(0, 255) : (channelIdFallback || null),
    logo: channel.logo ? String(channel.logo).slice(0, 512) : null,
    category: channel.category ? String(channel.category).slice(0, 120) : null,
  };
};

const findPlaylistOwned = async (userId, playlistId) =>
  prisma.playlist.findFirst({ where: { id: playlistId, userId } });

// ─── CRUD ───────────────────────────────────────────────────

const createPlaylist = async (userId, { name, description = '' }) => {
  const cleanName = String(name || '').trim();
  if (!cleanName) throw InputError('O nome da playlist é obrigatório.', 422);
  if (cleanName.length > 80) throw InputError('O nome deve ter no máximo 80 caracteres.', 422);
  const cleanDesc = String(description || '').trim().slice(0, 280);

  const playlist = await prisma.playlist.create({
    data: { userId, name: cleanName, description: cleanDesc },
  });
  inc('playlistOps');
  return playlist;
};

const listPlaylists = async (userId, { limit = 20, page = 1 } = {}) => {
  const take = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const skip = (Math.max(Number(page) || 1, 1) - 1) * take;

  const [playlists, total] = await Promise.all([
    prisma.playlist.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      skip,
      take,
      include: { _count: { select: { channels: true } } },
    }),
    prisma.playlist.count({ where: { userId } }),
  ]);

  return {
    items: playlists.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      channelCount: p._count.channels,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    })),
    total,
    page: Math.max(Number(page) || 1, 1),
    limit: take,
  };
};

const getPlaylist = async (userId, playlistId) => {
  const playlist = await findPlaylistOwned(userId, playlistId);
  if (!playlist) {
    const e = new Error('Playlist não encontrada.');
    e.statusCode = 404;
    e.code = 'NOT_FOUND';
    throw e;
  }
  return playlist;
};

const listPlaylistChannels = async (userId, playlistId, { limit = 50, offset = 0 } = {}) => {
  await getPlaylist(userId, playlistId);
  const take = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const skip = Math.max(Number(offset) || 0, 0);

  const [rows, total] = await Promise.all([
    prisma.playlistChannel.findMany({
      where: { playlistId },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      skip,
      take,
    }),
    prisma.playlistChannel.count({ where: { playlistId } }),
  ]);

  return {
    items: rows.map((r) => ({
      id: r.channelId,
      // channelName é nullable no banco: nunca devolver label null —
      // o channelId é um label estável e não-sensível.
      name: r.channelName || r.channelId,
      logo: r.channelLogo,
      category: r.channelCategory,
    })),
    total,
  };
};

const updatePlaylist = async (userId, playlistId, { name, description }) => {
  await getPlaylist(userId, playlistId);
  const cleanName = name !== undefined ? String(name).trim() : undefined;
  if (cleanName !== undefined && (!cleanName || cleanName.length > 80)) {
    throw InputError('O nome deve ter entre 1 e 80 caracteres.', 422);
  }
  const cleanDesc =
    description !== undefined ? String(description).trim().slice(0, 280) : undefined;

  const updated = await prisma.playlist.update({
    where: { id: playlistId },
    data: {
      ...(cleanName !== undefined ? { name: cleanName } : {}),
      ...(cleanDesc !== undefined ? { description: cleanDesc } : {}),
    },
  });
  inc('playlistOps');
  return updated;
};

const deletePlaylist = async (userId, playlistId) => {
  await getPlaylist(userId, playlistId);
  // Orphan removal via onDelete: Cascade remove playlist_channels.
  await prisma.playlist.delete({ where: { id: playlistId } });
  inc('playlistOps');
  return { deleted: true };
};

// ─── Canais na playlist ─────────────────────────────────────

const _alreadySavedError = (playlistId, playlistName) => {
  const existingPlaylist = { id: playlistId, name: playlistName };
  const e = new Error(
    existingPlaylist.id
      ? `Este canal já está salvo na playlist "${existingPlaylist.name}".`
      : 'Este canal já está salvo em uma playlist.'
  );
  e.statusCode = 409;
  e.code = 'CHANNEL_ALREADY_SAVED';
  e.existingPlaylist = existingPlaylist;
  return e;
};

/**
 * Adiciona um canal à playlist, garantindo a regra de unicidade
 * (1 canal = 1 playlist por usuário) contra condições de corrida.
 */
const addChannel = async (userId, playlistId, channelId, channelMeta) => {
  if (!channelId || typeof channelId !== 'string' || channelId.length > 255) {
    throw InputError('channelId inválido.', 422);
  }

  const playlist = await findPlaylistOwned(userId, playlistId);
  if (!playlist) {
    const e = new Error('Playlist não encontrada.');
    e.statusCode = 404;
    e.code = 'NOT_FOUND';
    throw e;
  }

  // Pré-checagem (consulta barata; a constraint do banco é a garantia real).
  const existing = await prisma.playlistChannel.findFirst({
    where: { userId, channelId },
    select: { playlistId: true, playlist: { select: { name: true } } },
  });
  if (existing) throw _alreadySavedError(existing.playlistId, existing.playlist.name);

  const count = await prisma.playlistChannel.count({ where: { playlistId } });
  if (count >= config.analytics.maxChannelsPerPlaylist) {
    throw InputError('Esta playlist atingiu o limite de canais.', 422, 'PLAYLIST_FULL');
  }

  const meta = channelSnapshot(channelMeta, channelId);
  const position = count;

  try {
    const row = await prisma.playlistChannel.create({
      data: {
        playlistId,
        userId,
        channelId,
        channelName: meta.name,
        channelLogo: meta.logo,
        channelCategory: meta.category,
        position,
      },
    });
    inc('playlistOps');
    return row;
  } catch (e) {
    // Corrida: outra requisição (ou outra playlist) ganhou o mesmo canal.
    if (e.code === 'P2002') {
      const landed = await prisma.playlistChannel.findFirst({
        where: { userId, channelId },
        select: { playlistId: true, playlist: { select: { name: true } } },
      });
      throw _alreadySavedError(landed?.playlistId, landed?.playlist?.name);
    }
    throw e;
  }
};

/**
 * Cria uma playlist e já adiciona o canal (fluxo "+ Criar nova playlist"
 * no modal de salvar). Transação: se o canal violar a unicidade, a
 * playlist criada é revertida — nenhum estado inconsistente.
 */
const createPlaylistWithChannel = async (userId, { name, description = '' }, channelId, channelMeta) => {
  const cleanName = String(name || '').trim();
  if (!cleanName) throw InputError('O nome da playlist é obrigatório.', 422);

  const existing = await prisma.playlistChannel.findFirst({
    where: { userId, channelId },
    select: { playlistId: true, playlist: { select: { name: true } } },
  });
  if (existing) throw _alreadySavedError(existing.playlistId, existing.playlist.name);

  const meta = channelSnapshot(channelMeta, channelId);

  try {
    const playlist = await prisma.$transaction(async (tx) => {
      const created = await tx.playlist.create({
        data: { userId, name: cleanName, description: String(description || '').trim().slice(0, 280) },
      });
      await tx.playlistChannel.create({
        data: {
          playlistId: created.id,
          userId,
          channelId,
          channelName: meta.name,
          channelLogo: meta.logo,
          channelCategory: meta.category,
          position: 0,
        },
      });
      return created;
    });
    inc('playlistOps');
    return playlist;
  } catch (e) {
    // Corrida: outra requisição ganhou o canal entre a pré-checagem e o
    // commit. A transação já reverteu a playlist criada; só trocamos o
    // erro Prisma cru pelo 409 amigável apontando a playlist dona do canal.
    if (e.code === 'P2002') {
      const landed = await prisma.playlistChannel.findFirst({
        where: { userId, channelId },
        select: { playlistId: true, playlist: { select: { name: true } } },
      });
      throw _alreadySavedError(landed?.playlistId, landed?.playlist?.name);
    }
    throw e;
  }
};

/**
 * Remove um canal de uma playlist (só o canal da playlist — nunca exclui
 * metadados de canal, que nem existem no banco).
 */
const removeChannel = async (userId, playlistId, channelId) => {
  await getPlaylist(userId, playlistId);
  const result = await prisma.playlistChannel.deleteMany({
    where: { playlistId, userId, channelId },
  });
  if (result.count === 0) {
    const e = new Error('Canal não está nesta playlist.');
    e.statusCode = 404;
    e.code = 'NOT_FOUND';
    throw e;
  }
  inc('playlistOps');
  // Recomenda? manutenção de posições: reordena por position original.
  // Como usamos position + createdAt, buracos não quebram a ordenação.
  return { deleted: true };
};

/**
 * Localiza a playlist do usuário que contém um canal (para o modal
 * "Salvar na playlist" informar "Este canal já está salvo em ...").
 */
const findPlaylistForChannel = async (userId, channelId) => {
  const row = await prisma.playlistChannel.findFirst({
    where: { userId, channelId },
    select: { playlistId: true, playlist: { select: { name: true } } },
  });
  if (!row) return null;
  return { playlistId: row.playlistId, name: row.playlist.name };
};

module.exports = {
  createPlaylist,
  listPlaylists,
  getPlaylist,
  listPlaylistChannels,
  updatePlaylist,
  deletePlaylist,
  addChannel,
  createPlaylistWithChannel,
  removeChannel,
  findPlaylistForChannel,
};