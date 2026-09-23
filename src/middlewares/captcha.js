'use strict';

const captchaService = require('../services/captchaService');

// ReCAPTCHA v2 — verificação de token nas ações públicas de autenticação
// (login, register, forgot-password, reset-password).
//
// Fail-open: sem CAPTCHA_SECRET_KEY não há verificação (o widget também não
// é renderizado no frontend). Com o segredo configurado, o token enviado no
// corpo (`captchaToken`) é obrigatório e validado contra a API do Google.
module.exports = function verifyCaptcha(req, res, next) {
  const secret = process.env.CAPTCHA_SECRET_KEY;
  if (!secret) return next();

  const token = req.body && req.body.captchaToken;
  if (!token || typeof token !== 'string') {
    return res.status(422).json({
      success: false,
      message: 'CAPTCHA obrigatório.',
      errors: [{ field: 'captchaToken', message: 'Complete o CAPTCHA para continuar.' }],
    });
  }

  const remoteIp = req.ip || (req.socket && req.socket.remoteAddress) || '';

  return captchaService.verifyToken(token, remoteIp).then((result) => {
    if (!result.valid) {
      return res.status(422).json({
        success: false,
        message: result.reason || 'CAPTCHA inválido. Tente novamente.',
        errors: [{ field: 'captchaToken', message: result.reason || 'CAPTCHA inválido. Tente novamente.' }],
      });
    }
    return next();
  });
};