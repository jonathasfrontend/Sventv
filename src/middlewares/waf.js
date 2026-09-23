'use strict';

const crypto = require('crypto');
const config = require('../config/app');
const logger = require('../utils/logger');
const { inc } = require('../utils/metrics');
const { isRedisAvailable, makeKey, setWithTTL, get } = require('../services/redisStore');
const alertService = require('../services/alertService');

const SUSPICIOUS_PATTERNS = [
  /(\.\.|\/etc\/passwd|\/etc\/shadow)/i,
  /(union\s+select|drop\s+table|insert\s+into|delete\s+from|update\s+.+\s+set\s+)/i,
  /(<script|javascript:|data:text\/html|<iframe)/i,
  /(\$where|\$regex|\$gt|\$lt|__proto__|constructor\.)/,
  /(eval\(|Function\(|setTimeout\(|setInterval\()/i,
  /(alert\(|prompt\(|confirm\()/i,
  /(select\s+.+\s+from\s+|insert\s+into|update\s+.+\s+where)/i,
  /(cmd=|exec=|command=|run=)/i,
  /(\b OR \b1\s*=\s*1|\b OR\b)/i,
  /(;|\|\||&&)\s*(cat|ls|id|whoami|uname|pwd)/i,
];

const PATH_TRAVERSAL_RE = /(\.\.[\\/]|\.\.[\\\/])/;
const SQL_KEYWORDS_RE = /\b(union|select|insert|delete|update|drop|create|alter|exec|execute)\b/i;
const XSS_KEYWORDS_RE = /<script|javascript:|<iframe|onerror=|onload=|onclick=/i;

const SECURITY_EVENTS = {
  SQL_INJECTION: 'security.sql_injection.detected',
  XSS: 'security.xss.detected',
  PATH_TRAVERSAL: 'security.path_traversal.detected',
  SSRF: 'security.ssrf.blocked',
  IDOR_DENIED: 'security.idor.denied',
  RATE_LIMIT_EXCEEDED: 'security.rate_limit.exceeded',
  AUTH_BRUTE_FORCE: 'security.auth.bruteforce',
  ROUTE_ENUMERATION: 'security.route.enumeration',
  SUSPICIOUS_PAYLOAD: 'security.suspicious.payload',
};

const BLOCK_THRESHOLDS = {
  suspiciousRequestsPerIpPerWindow: { windowMs: 60_000, max: 10 },
  blockedRequestsPerIpPerWindow: { windowMs: 60_000, max: 20 },
  loginFailuresPerIpPerWindow: { windowMs: 60_000, max: 15 },
};

const _ipBlocklists = new Map();
let _blocklistInitialized = false;

function _initBlocklist() {
  if (_blocklistInitialized) return;
  _blocklistInitialized = true;
  try {
    const raw = process.env.WAF_BLOCKED_IPS || '';
    if (!raw) return;
    raw.split(',').map((s) => s.trim()).filter(Boolean).forEach((ip) => {
      _ipBlocklists.set(ip, true);
    });
  } catch (_) { /* empty */ }
}

function isBlockedIp(ip) {
  _initBlocklist();
  if (!ip) return false;
  return _ipBlocklists.has(ip) || _ipBlocklists.has(ip.split(':').pop());
}

function isApiPath(req) {
  return req.path && req.path.startsWith('/api/');
}

function classifyThreat(url, bodyStr) {
  const threats = [];
  const combined = url + ' ' + bodyStr;
  for (const pattern of SUSPICIOUS_PATTERNS) {
    if (pattern.test(combined)) {
      if (SQL_KEYWORDS_RE.test(combined)) threats.push(SECURITY_EVENTS.SQL_INJECTION);
      if (XSS_KEYWORDS_RE.test(combined) || /<script|javascript:|onerror=|onload=/.test(combined)) threats.push(SECURITY_EVENTS.XSS);
      if (PATH_TRAVERSAL_RE.test(combined)) threats.push(SECURITY_EVENTS.PATH_TRAVERSAL);
      if (!threats.length) threats.push(SECURITY_EVENTS.SUSPICIOUS_PAYLOAD);
      break;
    }
  }
  return threats;
}

async function _isRateLimited(req, key, threshold) {
  const windowKey = makeKey('waf', key);
  try {
    let count = 0;
    if (await isRedisAvailable()) {
      const raw = await get(windowKey);
      count = raw ? parseInt(raw, 10) || 0 : 0;
    } else {
      throw new Error('redis-unavailable');
    }
    if (count >= threshold.max) {
      return true;
    }
    return false;
  } catch (_) {
    const memKey = `_waf_mem:${key}`;
    const mem = _ipBlocklists.get(memKey);
    if (mem && Date.now() - mem < threshold.windowMs) {
      return mem.count >= threshold.max;
    }
    return false;
  }
}

async function _recordRequest(req, key, threshold) {
  const windowKey = makeKey('waf', key);
  try {
    if (await isRedisAvailable()) {
      const current = await get(windowKey);
      const count = current ? parseInt(current, 10) || 1 : 1;
      await setWithTTL(windowKey, String(count), Math.floor(threshold.windowMs / 1000));
      return count;
    }
  } catch (_) { /* memory fallback below */ }
}

const _memoryCounters = new Map();
function _memoryIncr(key, windowMs) {
  const now = Date.now();
  const entry = _memoryCounters.get(key);
  if (entry && now - entry.start < windowMs) {
    entry.count++;
    return entry.count;
  }
  const newEntry = { count: 1, start: now };
  _memoryCounters.set(key, newEntry);
  return 1;
}

async function recordSecurityEvent(eventKey, details) {
  inc('securityBlocks');
  try {
    const { audit } = require('../services/auditService');
    audit({
      action: eventKey,
      req: details.req,
      userId: details.userId || null,
      email: details.email || null,
      meta: {
        ip: details.ip,
        path: details.path,
        method: details.method,
        threats: details.threats,
        userAgent: details.userAgent,
      },
    });
  } catch (_) { /* non-blocking */ }

  alertService.notify(eventKey, {
    ip: details.ip,
    path: details.path,
    threats: details.threats,
  });
}

const waf = {
  classifyThreat,
  SECURITY_EVENTS,
  isBlockedIp,
};

const monitorRequests = (req, res, next) => {
  if (!isApiPath(req)) return next();
  const ip = req.ip || 'unknown';
  const url = req.originalUrl || '';
  const method = req.method;
  const ua = req.headers['user-agent'] || '';

  if (isBlockedIp(ip)) {
    inc('wafBlockedIp');
    logger.warn(`WAF: IP bloqueado: ${ip}`);
    return res.status(403).json({ success: false, message: 'Acesso negado.' });
  }

  const bodyStr = JSON.stringify(req.body || {}).slice(0, 2048);
  const threats = classifyThreat(url, bodyStr);

  if (threats.length) {
    inc('wafDetected');
    threats.forEach((t) => inc('waf:' + t));
    recordSecurityEvent(threats[0], {
      req, userId: req.user?._id || req.user?.id, ip, path: url, method, userAgent: ua, threats,
    });
    const key = `blocked:${ip}`;
    const count = _memoryIncr(key, 60_000);
    if (count >= BLOCK_THRESHOLDS.blockedRequestsPerIpPerWindow.max) {
      recordSecurityEvent('security.temporary.block', {
        req, ip, path: url, method, threats,
      });
      return res.status(403).json({ success: false, message: 'Acesso temporariamente bloqueado.' });
    }
    return res.status(403).json({ success: false, message: 'Requisição bloqueada por segurança.' });
  }

  next();
};

const trackBehavior = (req, res, next) => {
  if (!isApiPath(req)) return next();
  const ip = req.ip || 'unknown';
  const key = `track:${ip}`;
  inc('wafRequests');
  next();
};

const checkRateLimits = async (req, res, next) => {
  if (!isApiPath(req)) return next();
  const ip = req.ip || 'unknown';
  const isLogin = req.path.includes('/auth/login') || req.path.includes('/auth/register');
  const threshold = isLogin ? BLOCK_THRESHOLDS.loginFailuresPerIpPerWindow : BLOCK_THRESHOLDS.suspiciousRequestsPerIpPerWindow;
  try {
    if (await _isRateLimited(req, `rl:${ip}`, threshold)) {
      inc('wafRateLimited');
      recordSecurityEvent(SECURITY_EVENTS.RATE_LIMIT_EXCEEDED, {
        req, ip, path: req.originalUrl, method: req.method,
      });
      return res.status(429).json({ success: false, message: 'Muitas requisições. Aguarde.' });
    }
  } catch (_) { /* non-blocking */ }
  next();
};

module.exports = {
  waf,
  monitorRequests,
  trackBehavior,
  checkRateLimits,
  SECURITY_EVENTS,
};
