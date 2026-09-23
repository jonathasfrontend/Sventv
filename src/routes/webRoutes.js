'use strict';
const express = require('express');
const router = express.Router();
const { resolveUser, requireWebAuth, redirectIfAuthenticated, requireWebRole } = require('../middlewares/webAuth');
const M3UService = require('../services/m3uService');
const config = require('../config/app');
const { toPublicChannels } = require('../utils/publicChannel');

const m3uService = M3UService.getShared();

// Chave pública do reCAPTCHA (se configurada): usado para renderizar o
// widget nas páginas de auth. Vazia → widget não aparece e o backend
// permanece fail-open (sem CAPTCHA_SECRET_KEY não há verificação).
const captchaSiteKey = () => process.env.CAPTCHA_SITE_KEY || '';

// ── Páginas públicas ────────────────────────────────────────

// Landing page
router.get('/', resolveUser, (req, res) => {
  res.render('pages/index', {
    title: 'SvenTV',
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
    captchaSiteKey: captchaSiteKey(),
  });
});

router.get('/register', redirectIfAuthenticated, (req, res) => {
  const flash = req.session?.flash || null;
  if (req.session) req.session.flash = null;
  res.render('pages/register', {
    title: 'Registrar — SvenTV',
    user: null,
    flash,
    termsVersion: config.terms.version,
    captchaSiteKey: captchaSiteKey(),
  });
});

// Recuperação de senha — passo 1 (solicitar código)
router.get('/forgot-password', redirectIfAuthenticated, (req, res) => {
  const flash = req.session?.flash || null;
  if (req.session) req.session.flash = null;
  res.render('pages/forgot-password', {
    title: 'Recuperar senha — SvenTV',
    user: null,
    flash,
    termsVersion: config.terms.version,
    captchaSiteKey: captchaSiteKey(),
  });
});

// Recuperação de senha — passo 2 (informar código + nova senha)
router.get('/reset-password', (req, res) => {
  const flash = req.session?.flash || null;
  if (req.session) req.session.flash = null;
  res.render('pages/reset-password', {
    title: 'Redefinir senha — SvenTV',
    user: null,
    flash,
    email: req.query.email || '',
    termsVersion: config.terms.version,
    captchaSiteKey: captchaSiteKey(),
  });
});

// Termos de Uso — página institucional pública (sem autenticação)
router.get('/termos', resolveUser, (req, res) => {
  res.render('pages/termos', {
    title: 'Termos de Uso — SvenTV',
    user: req.user || null,
    termsVersion: config.terms.version,
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

router.get('/playlists', requireWebAuth, (req, res) => {
  res.render('pages/playlists', {
    title: 'Minhas Playlists — SvenTV',
    user: req.user,
  });
});

router.get('/guia', requireWebAuth, (req, res) => {
  // EPG_ENABLED=false → feature desligada: sem página (link some da navbar e
  // aqui redireciona). EPG_URL ausente NÃO bloqueia a página: a grade abre
  // com o estado vazio ("sem programação") até a URL ser configurada.
  const epgEnabled = Boolean(config.epg.enabled);
  if (!epgEnabled) {
    if (req.session) {
      req.session.flash = { type: 'info', message: 'O Guia de canais está desativado.' };
    }
    return res.redirect('/dashboard');
  }
  res.render('pages/guia', {
    title: 'Guia de Canais — SvenTV',
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
