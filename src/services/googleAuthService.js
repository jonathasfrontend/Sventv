'use strict';

const jwt = require('jsonwebtoken');
const axios = require('axios');
const crypto = require('crypto');
const config = require('../config/app');
const User = require('../models/User');
const logger = require('../utils/logger');
const metrics = require('../utils/metrics');
const alertService = require('../services/alertService');

const GOOGLE_OAUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';
const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

let _jwksCache = null;
let _jwksCacheExp = 0;

async function _getGoogleJWKS() {
  const now = Date.now();
  if (_jwksCache && now < _jwksCacheExp) return _jwksCache;
  try {
    const resp = await axios.get(GOOGLE_JWKS_URL, { timeout: 10_000 });
    _jwksCache = resp.data;
    _jwksCacheExp = now + 3_600_000;
    return _jwksCache;
  } catch (err) {
    logger.warn(`Google JWKS fetch failed: ${err && err.message}`);
    return _jwksCache || null;
  }
}

function _verifyGoogleIdToken(idToken) {
  return new Promise((resolve, reject) => {
    const jwt = require('jsonwebtoken');
    jwt.verify(idToken, _jwksCache && _jwksCache.keys ? undefined : undefined, {
      algorithms: ['RS256'],
      audience: process.env.GOOGLE_CLIENT_ID,
      issuer: ['accounts.google.com', 'https://accounts.google.com'],
    }, (err, decoded) => {
      if (err) return reject(new Error('Invalid Google ID token'));
      resolve(decoded);
    });
  });
}

async function getGoogleUserInfo(accessToken) {
  try {
    const resp = await axios.get(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: 10_000,
    });
    const data = resp.data;
    return {
      googleId: data.sub,
      email: data.email || null,
      name: data.name || null,
      givenName: data.given_name || null,
      familyName: data.family_name || null,
      picture: data.picture || null,
      verifiedEmail: data.verified_email || false,
    };
  } catch (err) {
    logger.warn(`Google userinfo fetch failed: ${err && err.message}`);
    throw new Error('Falha ao obter informações do Google.');
  }
}

async function exchangeCodeForToken(code) {
  try {
    const resp = await axios.post(GOOGLE_TOKEN_URL, new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID || '',
      client_secret: process.env.GOOGLE_CLIENT_SECRET || '',
      redirect_uri: process.env.GOOGLE_REDIRECT_URI || '',
      grant_type: 'authorization_code',
    }).toString(), {
      timeout: 10_000,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    return resp.data;
  } catch (err) {
    logger.warn(`Google token exchange failed: ${err && err.message}`);
    throw new Error('Falha na autenticação com o Google.');
  }
}

async function findOrCreateUser(googleInfo) {
  const existing = await User.findOne({ email: googleInfo.email });
  if (existing) {
    if (existing.googleId && existing.googleId !== googleInfo.googleId) {
      logger.warn(`Google ID mismatch for email ${googleInfo.email}: existing=${existing.googleId}, incoming=${googleInfo.googleId}`);
      metrics.inc('googleIdMismatch');
    }
    if (!existing.googleId) {
      try {
        await User.findByIdAndUpdate(existing._id, { googleId: googleInfo.googleId });
      } catch (err) {
        logger.warn(`Failed to link Google ID: ${err && err.message}`);
      }
    }
    if (googleInfo.picture) {
      try {
        const currentAvatar = existing.avatar || '';
        if (!currentAvatar || currentAvatar === '/images/default-avatar.png') {
          await User.findByIdAndUpdate(existing._id, { avatar: googleInfo.picture });
        }
      } catch (_) { /* non-blocking */ }
    }
    return { user: existing, created: false };
  }

  const defaultRole = await User.findRoleByCode('user');
  const newUser = await User.create({
    name: googleInfo.name || googleInfo.email || 'Usuário Google',
    email: googleInfo.email,
    password: crypto.randomBytes(32).toString('hex'),
    avatar: googleInfo.picture || '',
    googleId: googleInfo.googleId,
    status: 'active',
    role: 'user',
    roleId: defaultRole?.id || null,
    termsAcceptedAt: new Date(),
    termsVersion: config.terms.version,
  });
  metrics.inc('google.userCreated');
  alertService.notify('auth.user_registered:' + newUser._id, {
    event: 'auth.user_registered',
    userId: newUser._id,
    name: newUser.name,
    email: newUser.email,
    authProvider: 'google',
  });
  return { user: newUser, created: true };
}

async function generateSessionToken(user) {
  return jwt.sign(
    {
      id: user._id,
      email: user.email,
      role: user.role,
      sv: user.sessionVersion || 0,
    },
    config.jwt.secret,
    { expiresIn: config.jwt.expiresIn }
  );
}

const googleAuthService = {
  getGoogleUserInfo,
  exchangeCodeForToken,
  findOrCreateUser,
  generateSessionToken,
  getJWKS: _getGoogleJWKS,
};

module.exports = googleAuthService;
