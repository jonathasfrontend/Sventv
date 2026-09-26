'use strict';

/**
 * Google Auth FLOW tests — comportamento, não inspeção de fonte.
 *
 * Cenários cobertos (LOGIN != CADASTRO):
 *  1. loginWithGoogle: googleId existente → autentica (created=false), NUNCA cria.
 *  2. loginWithGoogle: googleId desconhecido → NEGA (ACCOUNT_NOT_FOUND), create NÃO é chamado.
 *  3. loginWithGoogle: email não verificado → EMAIL_UNVERIFIED (401).
 *  4. registerWithGoogle: googleId novo + email livre → cria com googleId/authProvider=google.
 *  5. registerWithGoogle: googleId já cadastrado → login idempotente, sem duplicar.
 *  6. registerWithGoogle: email já pertence a outra conta → EMAIL_ALREADY_EXISTS (409), sem vínculo silencioso.
 *  7. linkGoogleAccount: googleId já pertence a OUTRO usuário → GOOGLE_ID_OWNED (409).
 *  8. linkGoogleAccount: googleId livre + email livre → vínculo aplicado.
 *  9. linkGoogleAccount: já vinculado a esta conta → idempotente (alreadyLinked).
 * 10. unlinkGoogleAccount: conta criada via Google (sem senha utilizável) → UNLINK_BLOCKED (409).
 * 11. unlinkGoogleAccount: conta local com senha → desvincula (googleId=null).
 *
 * Alerta de registro usa _setSinks para NUNCA tocar SMTP/webhook reais.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const alertService = require('../src/services/alertService');
const User = require('../src/models/User');
const googleAuthService = require('../src/services/googleAuthService');

const { GoogleAuthError } = googleAuthService;

before(() => {
  alertService._setSinks({ sendEmail: async () => true, sendWebhook: async () => true });
});

after(() => {
  alertService._setSinks(null);
});

function makeUser(over = {}) {
  return {
    _id: 'usr-1',
    id: 'usr-1',
    name: 'Ana Teste',
    email: 'ana@example.com',
    password: 'hash-mock',
    avatar: '',
    googleId: null,
    authProvider: 'local',
    status: 'active',
    role: 'user',
    sessionVersion: 0,
    createdAt: new Date('2026-09-19T10:00:00Z'),
    ...over,
  };
}

const GOOGLE_INFO = {
  googleId: 'google-123456',
  email: 'ana.google@gmail.com',
  name: 'Ana Teste',
  picture: 'https://example.com/avatar.png',
  verifiedEmail: true,
};

// ── 1/2. LOGIN: existente autentica; desconhecido NEGA — login NUNCA cria ──

test('LOGIN: googleId existente → autentica sem criar (created=false)', async (t) => {
  const existing = makeUser({ googleId: 'google-123456', email: 'ana.google@gmail.com' });
  t.mock.method(User, 'findByGoogleId', async () => existing);
  let createCalled = false;
  t.mock.method(User, 'create', async () => { createCalled = true; return existing; });

  const { user, created } = await googleAuthService.loginWithGoogle(GOOGLE_INFO);

  assert.equal(created, false);
  assert.equal(user._id, 'usr-1');
  assert.equal(createCalled, false, 'LOGIN não deve chamar User.create');
});

test('LOGIN: googleId desconhecido → 401 ACCOUNT_NOT_FOUND e NÃO cria conta', async (t) => {
  t.mock.method(User, 'findByGoogleId', async () => null);
  let createCalled = false;
  t.mock.method(User, 'create', async () => { createCalled = true; throw new Error('não deveria criar'); });

  await assert.rejects(
    googleAuthService.loginWithGoogle(GOOGLE_INFO),
    (err) => err instanceof GoogleAuthError && err.code === 'ACCOUNT_NOT_FOUND' && err.statusCode === 401
  );
  assert.equal(createCalled, false, 'LOGIN NUNCA cria conta (LOGIN != CADASTRO)');
});

// ── 3. LOGIN: e-mail não verificado ──

test('LOGIN: e-mail não verificado → EMAIL_UNVERIFIED (401)', async (t) => {
  t.mock.method(User, 'findByGoogleId', async () => null);

  await assert.rejects(
    googleAuthService.loginWithGoogle({ ...GOOGLE_INFO, verifiedEmail: false }),
    (err) => err instanceof GoogleAuthError && err.code === 'EMAIL_UNVERIFIED' && err.statusCode === 401
  );
});

// ── 4. CADASTRO: cria conta com googleId (fonte de verdade) ──

test('CADASTRO: googleId novo + email livre → cria com googleId e authProvider=google', async (t) => {
  t.mock.method(User, 'findByGoogleId', async () => null);
  t.mock.method(User, 'findByEmail', async () => null);
  const createdUser = makeUser({
    googleId: GOOGLE_INFO.googleId,
    email: GOOGLE_INFO.email,
    authProvider: 'google',
    avatar: GOOGLE_INFO.picture,
  });
  let createArgs = null;
  t.mock.method(User, 'create', async (args) => { createArgs = args; return createdUser; });

  const { user, created } = await googleAuthService.registerWithGoogle(GOOGLE_INFO);

  assert.equal(created, true);
  assert.equal(user.authProvider, 'google');
  assert.equal(createArgs.googleId, GOOGLE_INFO.googleId);
  assert.equal(createArgs.authProvider, 'google');
  // Migração v2.0.1: avatar personalizado começa VAZIO; o picture fica em
  // googleAvatarUrl (avatar efetivo = avatar || googleAvatarUrl).
  assert.equal(createArgs.avatar, '', 'cadastro não usa picture como avatar personalizado');
  assert.equal(createArgs.googleAvatarUrl, GOOGLE_INFO.picture);
  assert.ok(createArgs.password && createArgs.password.length >= 40, 'senha deve ser aleatória forte (não utilizável para login local)');
});

// ── 5. CADASTRO: googleId já cadastrado → idempotente ──

test('CADASTRO: googleId já existente → login idempotente (sem duplicar)', async (t) => {
  const existing = makeUser({ googleId: GOOGLE_INFO.googleId, email: GOOGLE_INFO.email, authProvider: 'google' });
  t.mock.method(User, 'findByGoogleId', async () => existing);
  let createCalled = false;
  t.mock.method(User, 'create', async () => { createCalled = true; throw new Error('não duplica'); });

  const { user, created } = await googleAuthService.registerWithGoogle(GOOGLE_INFO);

  assert.equal(created, false);
  assert.equal(user._id, existing._id);
  assert.equal(createCalled, false, 'não deve criar segunda conta para o mesmo googleId');
});

// ── 6. CADASTRO: email já pertence a outra conta → rejeita (sem vínculo silencioso) ──

test('CADASTRO: email de outra conta → EMAIL_ALREADY_EXISTS (409), create não é chamado', async (t) => {
  t.mock.method(User, 'findByGoogleId', async () => null);
  const other = makeUser({ googleId: null, email: GOOGLE_INFO.email });
  t.mock.method(User, 'findByEmail', async () => other);
  let createCalled = false;
  t.mock.method(User, 'create', async () => { createCalled = true; throw new Error('não vincular silenciosamente'); });

  await assert.rejects(
    googleAuthService.registerWithGoogle(GOOGLE_INFO),
    (err) => err instanceof GoogleAuthError && err.code === 'EMAIL_ALREADY_EXISTS' && err.statusCode === 409
  );
  assert.equal(createCalled, false, 'nunca vincula/cria por cima de e-mail existente');
});

// ── 7. VÍNCULO: googleId de OUTRO usuário ──

test('VÍNCULO: googleId já vinculado a outro usuário → GOOGLE_ID_OWNED (409)', async (t) => {
  const current = makeUser({ _id: 'usr-a', email: 'a@example.com' });
  const other = makeUser({ _id: 'usr-b', googleId: GOOGLE_INFO.googleId, email: 'b@example.com' });
  t.mock.method(User, 'findByGoogleId', async () => other);

  await assert.rejects(
    googleAuthService.linkGoogleAccount(GOOGLE_INFO, current),
    (err) => err instanceof GoogleAuthError && err.code === 'GOOGLE_ID_OWNED' && err.statusCode === 409
  );
});

// ── 8. VÍNCULO: googleId + email livres → aplica (avatar intocado) ──

test('VÍNCULO: googleId livre e email livre → googleId + googleAvatarUrl gravados', async (t) => {
  const current = makeUser({ _id: 'usr-a', email: 'a@example.com' });
  t.mock.method(User, 'findByGoogleId', async () => null);
  t.mock.method(User, 'findByEmail', async () => null);
  let updateArg = null;
  const updated = { ...current, googleId: GOOGLE_INFO.googleId, googleAvatarUrl: GOOGLE_INFO.picture };
  t.mock.method(User, 'findByIdAndUpdate', async (_id, updates) => { updateArg = updates; return updated; });

  const { user, alreadyLinked } = await googleAuthService.linkGoogleAccount(GOOGLE_INFO, current);

  assert.equal(alreadyLinked, false);
  assert.equal(user.googleId, GOOGLE_INFO.googleId);
  assert.equal(user.googleAvatarUrl, GOOGLE_INFO.picture);
  assert.equal(user.avatar, current.avatar, 'avatar personalizado NUNCA é sobrescrito pelo link');
  assert.equal(updateArg.avatar, undefined, 'link não envia avatar no update');
  assert.equal(updateArg.googleAvatarUrl, GOOGLE_INFO.picture);
});

// ── 8b. VÍNCULO: usuário com avatar personalizado preserva o custom ──

test('VÍNCULO: avatar personalizado existente é preservado (googleAvatarUrl fica separado)', async (t) => {
  const current = makeUser({
    _id: 'usr-a',
    email: 'a@example.com',
    avatar: 'https://cdn.example.com/eu.png',
  });
  t.mock.method(User, 'findByGoogleId', async () => null);
  t.mock.method(User, 'findByEmail', async () => null);
  let updateArg = null;
  const updated = {
    ...current,
    googleId: GOOGLE_INFO.googleId,
    googleAvatarUrl: GOOGLE_INFO.picture,
  };
  t.mock.method(User, 'findByIdAndUpdate', async (_id, updates) => { updateArg = updates; return updated; });

  const { user } = await googleAuthService.linkGoogleAccount(GOOGLE_INFO, current);

  assert.equal(user.avatar, 'https://cdn.example.com/eu.png', 'o custom continua sendo o avatar efetivo');
  assert.equal(user.googleAvatarUrl, GOOGLE_INFO.picture);
  assert.ok(!('avatar' in updateArg), 'update não toca o campo avatar');
});

// ── 9. VÍNCULO: já vinculado à MESMA conta ──

test('VÍNCULO: googleId já é desta conta → idempotente (alreadyLinked=true)', async (t) => {
  const current = makeUser({ _id: 'usr-a', googleId: GOOGLE_INFO.googleId, email: GOOGLE_INFO.email });
  let updated = false;
  t.mock.method(User, 'findByIdAndUpdate', async () => { updated = true; return null; });

  const { alreadyLinked } = await googleAuthService.linkGoogleAccount(GOOGLE_INFO, current);

  assert.equal(alreadyLinked, true);
  assert.equal(updated, false, 'não reescreve quando já vinculado');
});

// ── 10. DESVÍNCULO: conta Google-only → bloqueado ──

test('DESVÍNCULO: conta criada via Google (sem senha utilizável) → UNLINK_BLOCKED (409)', async (t) => {
  t.mock.method(User, 'findByIdWithSensitive', async () =>
    makeUser({ googleId: GOOGLE_INFO.googleId, authProvider: 'google', password: 'hash-aleatorio-sem-senha-conhecida' })
  );
  let updatedCalled = false;
  t.mock.method(User, 'findByIdAndUpdate', async () => { updatedCalled = true; return null; });

  await assert.rejects(
    googleAuthService.unlinkGoogleAccount('usr-1'),
    (err) => err instanceof GoogleAuthError && err.code === 'UNLINK_BLOCKED' && err.statusCode === 409
  );
  assert.equal(updatedCalled, false, 'não pode desvincular deixando a conta sem login');
});

// ── 11. DESVÍNCULO: conta local com senha → desvincula ──

test('DESVÍNCULO: conta local com senha válida → googleId=null', async (t) => {
  const user = makeUser({ googleId: GOOGLE_INFO.googleId, authProvider: 'local', password: 'hash-de-senha-real' });
  t.mock.method(User, 'findByIdWithSensitive', async () => user);
  let updateArg = null;
  t.mock.method(User, 'findByIdAndUpdate', async (_id, updates) => { updateArg = updates; return { ...user, googleId: null }; });

  const { unlinked } = await googleAuthService.unlinkGoogleAccount('usr-1');

  assert.equal(unlinked, true);
  assert.ok(updateArg && updateArg.googleId === null);
  assert.ok(updateArg.googleAvatarUrl === null, 'desvincular também zera a fonte de avatar do Google');
});

// ── Extras de segurança ──

test('CADASTRO: e-mail não verificado → EMAIL_UNVERIFIED (antes de qualquer consulta)', async (t) => {
  let findCalled = false;
  t.mock.method(User, 'findByGoogleId', async () => { findCalled = true; return null; });

  await assert.rejects(
    googleAuthService.registerWithGoogle({ ...GOOGLE_INFO, verifiedEmail: false }),
    (err) => err instanceof GoogleAuthError && err.code === 'EMAIL_UNVERIFIED'
  );
  assert.equal(findCalled, false, 'nega antes de consultar banco');
});