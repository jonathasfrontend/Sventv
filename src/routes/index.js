'use strict';

const express = require('express');
const channelRoutes = require('./channelRoutes');
const authRoutes = require('./authRoutes');
const adminRoutes = require('./adminRoutes');

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

// Rota de informações da API
router.get('/info', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'SvenTV - API de Streaming de Canais de TV',
    version: '2.0.0',
    description: 'API para servir canais de TV ao vivo a partir de arquivo M3U com autenticação JWT',
    authentication: {
      type: 'Bearer JWT',
      header: 'Authorization: Bearer <seu_api_token>',
      howToGet: 'Crie uma conta em POST /auth/register e utilize o apiToken retornado.',
    },
    endpoints: {
      auth: {
        register: 'POST /auth/register',
        login: 'POST /auth/login',
        logout: 'POST /auth/logout',
        profile: 'GET /auth/profile',
        updateProfile: 'PUT /auth/profile',
        changePassword: 'POST /auth/change-password',
        regenerateToken: 'POST /auth/regenerate-token',
      },
      channels: {
        list: 'GET /api/channels',
        detail: 'GET /api/channels/:id',
        stream: 'GET /api/channels/:id/stream',
        categories: 'GET /api/channels/categories',
        search: 'GET /api/channels/search?q=termo',
        byCategory: 'GET /api/channels/category/:categoria',
        stats: 'GET /api/channels/stats',
      },
      admin: {
        page: 'GET /admin',
        users: 'GET /api/admin/users',
        changeRole: 'PUT /api/admin/users/:userId/role',
        blockUser: 'PUT /api/admin/users/:userId/block',
      },
    },
    timestamp: new Date().toISOString(),
  });
});

// Rotas de autenticação (públicas e protegidas por sessão)
router.use('/auth', authRoutes);

// Rotas dos canais (todas protegidas por API token)
router.use('/channels', channelRoutes);

// Painel administrativo
router.use('/admin', adminRoutes);

module.exports = router;
