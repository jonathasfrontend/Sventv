'use strict';

/**
 * WAF (src/middlewares/waf.js): testes unitários de classifyThreat,
 * isBlockedIp e constantes exportadas. A WAF bloqueia requisições
 * com payloads maliciosos (SQLi, XSS, path traversal) e registra
 * eventos de segurança.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { waf, SECURITY_EVENTS } = require('../src/middlewares/waf');

// ── classifyThreat: SQL Injection ──────────────────────────
// Payloads usam espaços reais (Express decodifica query params)
// ou padrões que casam diretamente com as regex do WAF.

test('classifyThreat: detecta SQL Injection (UNION SELECT)', () => {
  const threats = waf.classifyThreat('/api/channels?name=test UNION SELECT *', '');
  assert.ok(threats.includes(SECURITY_EVENTS.SQL_INJECTION), 'deve detectar SQLi');
});

test('classifyThreat: detecta SQL Injection (DROP TABLE)', () => {
  const threats = waf.classifyThreat('/api/users?q=DROP TABLE users', '');
  assert.ok(threats.includes(SECURITY_EVENTS.SQL_INJECTION), 'deve detectar DROP TABLE');
});

test('classifyThreat: detecta SQL Injection (OR 1=1)', () => {
  const threats = waf.classifyThreat('/api/auth/login', '{"email":"admin OR 1=1--"}');
  assert.ok(threats.length > 0, 'deve detectar OR 1=1 como ameaça');
});

test('classifyThreat: detecta SQL Injection (INSERT INTO)', () => {
  const threats = waf.classifyThreat('/api/data', '{"query":"INSERT INTO users VALUES"}');
  assert.ok(threats.includes(SECURITY_EVENTS.SQL_INJECTION));
});

test('classifyThreat: detecta SQL Injection (DELETE FROM)', () => {
  const threats = waf.classifyThreat('/api/data', '{"query":"DELETE FROM logs"}');
  assert.ok(threats.includes(SECURITY_EVENTS.SQL_INJECTION));
});

test('classifyThreat: detecta SQL Injection (UPDATE...WHERE)', () => {
  const threats = waf.classifyThreat('/api/settings', '{"q":"UPDATE users WHERE id=1 SET"}');
  assert.ok(threats.includes(SECURITY_EVENTS.SQL_INJECTION));
});

// ── classifyThreat: XSS ────────────────────────────────────

test('classifyThreat: detecta XSS (script tag)', () => {
  const threats = waf.classifyThreat('/api/search', '{"q":"<script>alert(1)</script>"}');
  assert.ok(threats.includes(SECURITY_EVENTS.XSS), 'deve detectar XSS script tag');
});

test('classifyThreat: detecta XSS (javascript: scheme)', () => {
  const threats = waf.classifyThreat('/api/redirect', '{"url":"javascript:alert(1)"}');
  assert.ok(threats.includes(SECURITY_EVENTS.XSS), 'deve detectar javascript: scheme');
});

test('classifyThreat: detecta XSS (iframe injection)', () => {
  const threats = waf.classifyThreat('/api/content', '{"html":"<iframe src=evil.com></iframe>"}');
  assert.ok(threats.includes(SECURITY_EVENTS.XSS), 'deve detectar iframe injection');
});

test('classifyThreat: detecta XSS (onerror event handler)', () => {
  const threats = waf.classifyThreat('/api/upload', '{"tag":"<img onerror=alert(1) src=x>"}');
  assert.ok(threats.includes(SECURITY_EVENTS.XSS), 'deve detectar onerror handler');
});

test('classifyThreat: detecta XSS (onload event handler)', () => {
  const threats = waf.classifyThreat('/api/data', '{"tag":"<img onload=alert(1) src=x>"}');
  assert.ok(threats.includes(SECURITY_EVENTS.XSS));
});

test('classifyThreat: detecta XSS (alert/prompt/confirm)', () => {
  const threats = waf.classifyThreat('/api/test', '{"msg":"alert(1)"}');
  assert.ok(threats.length > 0, 'deve detectar alert() como ameaça');
});

// ── classifyThreat: Path Traversal ─────────────────────────

test('classifyThreat: detecta path traversal (../)', () => {
  const threats = waf.classifyThreat('/api/files?path=../../../etc/passwd', '');
  assert.ok(threats.includes(SECURITY_EVENTS.PATH_TRAVERSAL), 'deve detectar path traversal');
});

test('classifyThreat: detecta path traversal (..\\)', () => {
  const threats = waf.classifyThreat('/api/files?path=..\\..\\windows\\system32', '');
  assert.ok(threats.includes(SECURITY_EVENTS.PATH_TRAVERSAL));
});

test('classifyThreat: detecta path traversal (/etc/passwd)', () => {
  const threats = waf.classifyThreat('/api/read?file=/etc/passwd', '');
  assert.ok(threats.length > 0, 'deve detectar /etc/passwd como suspeito');
});

test('classifyThreat: detecta path traversal (/etc/shadow)', () => {
  const threats = waf.classifyThreat('/api/read?file=/etc/shadow', '');
  assert.ok(threats.length > 0, 'deve detectar /etc/shadow como suspeito');
});

// ── classifyThreat: No false positives on benign input ───

test('classifyThreat: não detecta ameaça em requisição normal', () => {
  const threats = waf.classifyThreat('/api/channels?page=1&limit=20', '');
  assert.equal(threats.length, 0, 'requisição normal não deve gerar ameaças');
});

test('classifyThreat: não detecta ameaça em busca legítima', () => {
  const threats = waf.classifyThreat('/api/search?q=globo+novela', '');
  assert.equal(threats.length, 0, 'busca legítima não deve gerar ameaças');
});

test('classifyThreat: não detecta ameaça em login normal', () => {
  const threats = waf.classifyThreat('/api/auth/login', '{"email":"user@example.com","password":"Pass1234"}');
  assert.equal(threats.length, 0, 'login normal não deve gerar ameaças');
});

// ── classifyThreat: SUSPICIOUS_PAYLOAD fallback ──────────

test('classifyThreat: SUSPICIOUS_PAYLOAD para padrão suspeito (cmd=)', () => {
  const threats = waf.classifyThreat('/api/test?cmd=whoami', '');
  assert.ok(threats.length > 0, 'cmd= deve gerar ameaça');
});

test('classifyThreat: SUSPICIOUS_PAYLOAD para command=', () => {
  const threats = waf.classifyThreat('/api/run?command=id', '');
  assert.ok(threats.length > 0, 'command= deve gerar ameaça');
});

// ── SECURITY_EVENTS: todas as constantes existem ──────────────────

test('SECURITY_EVENTS: todas as constantes estão definidas', () => {
  assert.ok(SECURITY_EVENTS.SQL_INJECTION, 'SQL_INJECTION definido');
  assert.ok(SECURITY_EVENTS.XSS, 'XSS definido');
  assert.ok(SECURITY_EVENTS.PATH_TRAVERSAL, 'PATH_TRAVERSAL definido');
  assert.ok(SECURITY_EVENTS.SSRF, 'SSRF definido');
  assert.ok(SECURITY_EVENTS.IDOR_DENIED, 'IDOR_DENIED definido');
  assert.ok(SECURITY_EVENTS.RATE_LIMIT_EXCEEDED, 'RATE_LIMIT_EXCEEDED definido');
  assert.ok(SECURITY_EVENTS.AUTH_BRUTE_FORCE, 'AUTH_BRUTE_FORCE definido');
  assert.ok(SECURITY_EVENTS.ROUTE_ENUMERATION, 'ROUTE_ENUMERATION definido');
  assert.ok(SECURITY_EVENTS.SUSPICIOUS_PAYLOAD, 'SUSPICIOUS_PAYLOAD definido');
});

// ── isBlockedIp ────────────────────────────────────────────

test('isBlockedIp: retorna false para IP não bloqueado', () => {
  assert.equal(waf.isBlockedIp('192.168.1.100'), false);
});

test('isBlockedIp: retorna false para IP sem porta', () => {
  assert.equal(waf.isBlockedIp('10.0.0.1'), false);
});

test('isBlockedIp: retorna false para undefined', () => {
  assert.equal(waf.isBlockedIp(undefined), false);
});

test('isBlockedIp: retorna false para empty string', () => {
  assert.equal(waf.isBlockedIp(''), false);
});

test('isBlockedIp: parseia IPv6 com porta', () => {
  assert.equal(waf.isBlockedIp('[::1]:1234'), false);
});

// ── BLOCK_THRESHOLDS: object exportado ────────────────────

test('waf: classifyThreat é função', () => {
  assert.equal(typeof waf.classifyThreat, 'function');
});

test('waf: SECURITY_EVENTS é objeto', () => {
  assert.equal(typeof SECURITY_EVENTS, 'object');
  assert.ok(Object.keys(SECURITY_EVENTS).length >= 9);
});
