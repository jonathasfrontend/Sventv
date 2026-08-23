'use strict';
const express = require('express');
const router = express.Router();
const { resolveUser, requireWebAuth, redirectIfAuthenticated, requireWebRole } = require('../middlewares/webAuth');
const M3UService = require('../services/m3uService');
const { toPublicChannels } = require('../utils/publicChannel');

const m3uService = M3UService.getShared();

// ── Páginas públicas ────────────────────────────────────────

// Landing page
router.get('/', resolveUser, (req, res) => {
  res.render('pages/index', {
    title: 'SvenTV',
    user: req.user || null,
  });
});

// Documentação
router.get('/docs', resolveUser, (req, res) => {
  res.render('pages/docs', {
    title: 'Documentação — SvenTV',
    user: req.user || null,
  });
});

// ── Páginas de autenticação (redireciona se já logado) ──────

router.get('/login', redirectIfAuthenticated, (req, res) => {
  const flash = req.session?.flash || null;
  if (req.session) req.session.flash = null;
  res.render('pages/login', {
    title: 'Login — SvenTV',
    user: null,
    flash,
    returnTo: req.query.returnTo || '/dashboard',
  });
});

router.get('/register', redirectIfAuthenticated, (req, res) => {
  const flash = req.session?.flash || null;
  if (req.session) req.session.flash = null;
  res.render('pages/register', {
    title: 'Registrar — SvenTV',
    user: null,
    flash,
  });
});

// ── Páginas protegidas ──────────────────────────────────────

router.get('/dashboard', requireWebAuth, (req, res) => {
  // Busca canais e categorias via SSR — elimina dependência de fetch com token no carregamento inicial.
  // Canais são sanitizados (sem url/source): o HTML nunca carrega a origem real dos streams.
  let channels = [];
  let categories = [];
  let totalChannels = 0;

  try {
    const PAGE_SIZE = 24;
    const allChannels = m3uService.getAllChannels();
    totalChannels = allChannels.length;
    channels = toPublicChannels(allChannels.slice(0, PAGE_SIZE));
    const catSet = new Set(allChannels.map(ch => ch.category).filter(Boolean));
    categories = [...catSet].sort();
  } catch (_) {
    // Se o serviço falhar, o JS do cliente faz o fetch normalmente
  }

  res.render('pages/dashboard', {
    title: 'Dashboard — SvenTV',
    user: req.user,
    channels,
    categories,
    totalChannels,
  });
});

router.get('/profile', requireWebAuth, (req, res) => {
  res.render('pages/profile', {
    title: 'Meu Perfil — SvenTV',
    user: req.user,
  });
});

router.get('/admin', requireWebRole('admin'), (req, res) => {
  res.render('pages/admin', {
    title: 'Painel — SvenTV',
    user: req.user,
  });
});

module.exports = router;
