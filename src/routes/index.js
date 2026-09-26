'use strict';

const express = require('express');
const channelRoutes = require('./channelRoutes');
const epgRoutes = require('./epgRoutes');
const authRoutes = require('./authRoutes');
const googleRoutes = require('./googleRoutes');
const adminRoutes = require('./adminRoutes');
const userRoutes = require('./userRoutes');
const playbackRoutes = require('./playbackRoutes');
const trendingRoutes = require('./trendingRoutes');
const internalRoutes = require('./internalRoutes');

const router = express.Router();

/**
 * Rotas principais da API
 */

// Rota de saúde da API — mínima de propósito:
// sem versão do Node, pid, memória ou plataforma (fingerprinting).
router.get('/health', (req, res) => {
  res.status(200).json({
    success: true,
    status: 'healthy',
    message: 'SvenTV API está funcionando corretamente',
    timestamp: new Date().toISOString(),
  });
});

// Rotas de autenticação (públicas e protegidas por sessão)
router.use('/auth', authRoutes);
router.use('/google', googleRoutes);

// Rotas dos canais (todas protegidas por API token)
router.use('/channels', channelRoutes);

// Rotas do guia de programação (EPG — protegidas por API token)
router.use('/epg', epgRoutes);

// Painel administrativo
router.use('/admin', adminRoutes);

// Área pessoal (dashboard, histórico, playlists, recomendações)
router.use('/', userRoutes);

// Tendências (programações ao vivo em alta)
router.use('/trending', trendingRoutes);

// Ingestão de eventos de playback (transições + heartbeat)
router.use('/playback', playbackRoutes);

// Rotas internas (Vercel Cron / jobs) — protegidas por CRON_SECRET e
// fora das rotas de API autenticadas por usuário.
router.use('/internal', internalRoutes);

module.exports = router;
