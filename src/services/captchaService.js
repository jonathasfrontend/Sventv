'use strict';

const crypto = require('crypto');
const axios = require('axios');
const config = require('../config/app');
const logger = require('../utils/logger');
const metrics = require('../utils/metrics');
const { isRedisAvailable, makeKey, setWithTTL, get } = require('../services/redisStore');
const { inc } = require('../utils/metrics');
const alertService = require('../services/alertService');

const DEFAULT_SITE_KEY = '';
const DEFAULT_SECRET_KEY = '';
const VERIFY_URL = 'https://www.google.com/recaptcha/api/siteverify';
const TOKEN_TTL_MS = 300_000;
const TOKEN_LENGTH = 32;

function generateToken() {
  return crypto.randomBytes(TOKEN_LENGTH).toString('hex');
}

async function getSiteKey() {
  return process.env.CAPTCHA_SITE_KEY || DEFAULT_SITE_KEY;
}

async function verifyToken(token, remoteIp) {
  if (!token || typeof token !== 'string' || token.length < 10) {
    return { valid: false, reason: 'Token inválido.' };
  }

  const secret = process.env.CAPTCHA_SECRET_KEY || DEFAULT_SECRET_KEY;
  if (!secret) {
    logger.warn('CAPTCHA_SECRET_KEY não configurado — CAPTCHA desabilitado (fallback seguro).');
    return { valid: false, reason: 'CAPTCHA não configurado.' };
  }

  try {
    const params = new URLSearchParams();
    params.set('secret', secret);
    params.set('response', token);
    params.set('remoteip', remoteIp || 'unknown');

    const response = await axios.post(VERIFY_URL, params.toString(), {
      timeout: 10_000,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    const data = response.data;
    if (!data.success || data.success !== true) {
      metrics.inc('captchaFailures');
      return { valid: false, reason: 'CAPTCHA falhou. Tente novamente.' };
    }

    metrics.inc('captchaSuccesses');
    return { valid: true };
  } catch (err) {
    metrics.inc('captchaFailures');
    logger.warn(`CAPTCHA verification failed: ${err && err.message}`);
    alertService.notify('email.smtp_failure', { context: 'captcha_verification' });
    return { valid: false, reason: 'Erro ao validar CAPTCHA. Tente novamente.' };
  }
}

async function storeChallenge(token, challenge) {
  try {
    await setWithTTL(makeKey('captcha', token), challenge, TOKEN_TTL_MS / 1000);
    return true;
  } catch (err) {
    logger.warn(`CAPTCHA store failed: ${err && err.message}`);
    return false;
  }
}

async function consumeChallenge(token) {
  try {
    const key = makeKey('captcha', token);
    const challenge = await get(key);
    if (!challenge) {
      return { consumed: false, reason: 'Token expirado ou reutilizado.' };
    }
    await setWithTTL(key, '', 1);
    return { consumed: true, challenge };
  } catch (err) {
    logger.warn(`CAPTCHA consume failed: ${err && err.message}`);
    return { consumed: false, reason: 'Erro interno.' };
  }
}

async function isRequired(userId, action) {
  if (!userId && action === 'login') return true;
  if (!userId && action === 'register') return true;
  if (!userId && action === 'forgot-password') return true;
  if (!userId && action === 'reset-password') return true;
  const key = makeKey('captcha:state', userId || 'anon', action);
  try {
    let count = 0;
    if (await isRedisAvailable()) {
      const raw = await get(key);
      count = raw ? parseInt(raw, 10) || 0 : 0;
    } else {
      throw new Error('redis-unavailable');
    }
    return count >= 5;
  } catch (_) {
    return false;
  }
}

async function recordAttempt(userId, action) {
  const key = makeKey('captcha:state', userId || 'anon', action);
  try {
    if (await isRedisAvailable()) {
      const current = await get(key);
      const count = current ? parseInt(current, 10) + 1 : 1;
      await setWithTTL(key, String(count), 3600);
    }
  } catch (_) { /* non-blocking */ }
}

const captchaService = {
  getSiteKey,
  generateToken,
  verifyToken,
  storeChallenge,
  consumeChallenge,
  isRequired,
  recordAttempt,
};

module.exports = captchaService;
