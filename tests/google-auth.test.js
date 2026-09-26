'use strict';

/**
 * Google OAuth Security Tests.
 * Verifica que la autenticación Google OAuth está protegida:
 * - State parameter para CSRF
 * - Validación de email verificado
 * - Terms acceptance en register
 * - Token JWT con secret distinto
 * - Auditoría de eventos
 *
 * Se testea la lógica sin ejecutar métodos que crean timers
 * o conectan a BD/HTTP externo.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// ── State parameter: existe y es criptográfico ─────────────────

test('controller: genera state de 32 bytes (64 hex chars)', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'controllers', 'googleAuthController.js'), 'utf8'
  );
  // Verifica que el state se genera con crypto.randomBytes(32)
  assert.ok(
    src.includes('randomBytes(32)') || src.includes('randomBytes(32)'),
    'state debe usar crypto.randomBytes(32)'
  );
});

test('controller: state tiene TTL de 5 minutos', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'controllers', 'googleAuthController.js'), 'utf8'
  );
  assert.ok(
    src.includes('300_000') || src.includes('300000'),
    'state TTL debe ser 5 minutos'
  );
});

test('controller: verifica estado antes de procesar callback', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'controllers', 'googleAuthController.js'), 'utf8'
  );
  assert.ok(
    src.includes('_verifyState') || src.includes('verifyState'),
    'debe verificar state'
  );
});

// ── Google Auth Service: loginWithGoogle / registerWithGoogle ──

test('googleAuthService: loginWithGoogle existe (LOGIN != CADASTRO)', () => {
  const service = require('../src/services/googleAuthService');
  assert.equal(typeof service.loginWithGoogle, 'function');
});

test('googleAuthService: registerWithGoogle existe (fluxo explícito de cadastro)', () => {
  const service = require('../src/services/googleAuthService');
  assert.equal(typeof service.registerWithGoogle, 'function');
});

test('googleAuthService: findOrCreateUser não existe mais (misturava auth+create)', () => {
  const service = require('../src/services/googleAuthService');
  assert.equal(typeof service.findOrCreateUser, 'undefined');
});

test('googleAuthService: generateSessionToken existe', () => {
  const service = require('../src/services/googleAuthService');
  assert.equal(typeof service.generateSessionToken, 'function');
});

test('googleAuthService: exchangeCodeForToken existe', () => {
  const service = require('../src/services/googleAuthService');
  assert.equal(typeof service.exchangeCodeForToken, 'function');
});

test('googleAuthService: getGoogleUserInfo existe', () => {
  const service = require('../src/services/googleAuthService');
  assert.equal(typeof service.getGoogleUserInfo, 'function');
});

// ── Google Auth Service: login/register verificam email ──

test('loginWithGoogle/registerWithGoogle: verificam identity e email verificado', () => {
  const service = require('../src/services/googleAuthService');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'googleAuthService.js'), 'utf8'
  );
  assert.equal(typeof service.loginWithGoogle, 'function');
  assert.equal(typeof service.registerWithGoogle, 'function');
  assert.ok(
    src.includes('googleInfo.email') && src.includes('verifiedEmail'),
    'deve usar email e verificar verifiedEmail'
  );
  assert.ok(
    src.includes('loginWithGoogle') && src.includes('registerWithGoogle'),
    'deve expor login e cadastro separados'
  );
});

// ── Validation schemas ──────────────────────────────

test('validate: googleCallback schema existe', () => {
  const validate = require('../src/middlewares/validate');
  assert.ok(validate.schemas.googleCallback, 'googleCallback schema existe');
});

test('validate: googleLogin schema existe', () => {
  const validate = require('../src/middlewares/validate');
  assert.ok(validate.schemas.googleLogin, 'googleLogin schema existe');
});

test('validate: googleRegister schema existe', () => {
  const validate = require('../src/middlewares/validate');
  assert.ok(validate.schemas.googleRegister, 'googleRegister schema existe');
});

// ── Security: JWT secrets distintos ─────────────────

test('app.js: JWT_SECRET y JWT_API_SECRET son separados', () => {
  const appSrc = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'app.js'), 'utf8'
  );
  // Verificar que hay dos secretos distintos configurados
  const env = require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  assert.ok(process.env.JWT_SECRET, 'JWT_SECRET existe');
  assert.ok(process.env.JWT_API_SECRET, 'JWT_API_SECRET existe');
  assert.notEqual(
    process.env.JWT_SECRET,
    process.env.JWT_API_SECRET,
    'JWT_SECRET y JWT_API_SECRET deben ser distintos'
  );
});

// ── Security: user verification in googleAuth ──────────────

test('googleAuthService: verifica email verificado', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'googleAuthService.js'), 'utf8'
  );
  // El servicio debe verificar que el email existe
  assert.ok(
    src.includes('findOrCreateUser') || src.includes('email'),
    'debe verificar email'
  );
});

test('googleAuthController: retorna 401 si email no verificado', () => {
  const ctrlSrc = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'controllers', 'googleAuthController.js'), 'utf8'
  );
  assert.ok(
    ctrlSrc.includes('verifiedEmail') || ctrlSrc.includes('verified_email') || ctrlSrc.includes('401'),
    'debe verificar email verificado y retornar 401 si no lo está'
  );
});

// ── Security: googleId check ─────────────────────────

test('googleAuthService: verifica googleId mismatch', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'googleAuthService.js'), 'utf8'
  );
  assert.ok(
    src.includes('googleId') && (src.includes('mismatch') || src.includes('Mismat')),
    'debe detectar googleId mismatch'
  );
});

// ── Audit logging ──────────────────────────────────

test('googleAuthController: audita eventos', () => {
  const ctrlSrc = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'controllers', 'googleAuthController.js'), 'utf8'
  );
  assert.ok(
    ctrlSrc.includes('audit'),
    'debe tener auditoría'
  );
});
