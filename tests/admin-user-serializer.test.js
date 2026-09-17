'use strict';

/**
 * Garantia da DTO admin de usuário (src/utils/adminUserSerializer.js):
 * whitelist de campos expostos. NUNCA vaza password, apiToken,
 * sessionVersion, loginAttempts, lockUntil etc. — mesmo que o handler receba
 * um objeto "gordo" vindo do banco.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { serializeAdminUser, serializeAdminUserList } = require('../src/utils/adminUserSerializer');

const FAT_USER = {
  id: 'usr-1',
  name: 'Fulana',
  email: 'fulana@example.com',
  avatar: 'https://cdn.example.com/a.png',
  role: 'user',
  status: 'active',
  accountRestricted: true,
  restrictedReason: 'inadimplência',
  lastLogin: new Date('2026-01-01T00:00:00Z'),
  lastLoginIp: '203.0.113.9',
  termsAcceptedAt: new Date('2026-01-01T00:00:00Z'),
  termsVersion: 1,
  createdAt: new Date('2025-12-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  // Campos que JAMAIS podem vazar:
  password: '$2b$10$hashed',
  apiToken: 'jwt.api.token',
  apiTokenVersion: 7,
  apiTokenActive: false,
  sessionVersion: 42,
  loginAttempts: 999,
  lockUntil: new Date('2099-01-01T00:00:00Z'),
  totpSecret: 'SECRET',
  internalNote: 'não expor',
};

const SENSITIVE_KEYS = [
  'password',
  'apiToken',
  'apiTokenVersion',
  'apiTokenActive',
  'sessionVersion',
  'loginAttempts',
  'lockUntil',
  'totpSecret',
  'internalNote',
];

test('serializeAdminUser: nunca expõe campos sensíveis', () => {
  const out = serializeAdminUser(FAT_USER);
  for (const key of SENSITIVE_KEYS) {
    assert.equal(key in out, false, `campo sensível "${key}" vazou na DTO`);
  }
});

test('serializeAdminUser: mantém os campos da whitelist com valores corretos', () => {
  const out = serializeAdminUser(FAT_USER);
  assert.equal(out.id, 'usr-1');
  assert.equal(out.name, 'Fulana');
  assert.equal(out.email, 'fulana@example.com');
  assert.equal(out.avatar, 'https://cdn.example.com/a.png');
  assert.equal(out.role, 'user');
  assert.equal(out.status, 'active');
  assert.equal(out.accountRestricted, true);
  assert.equal(out.restrictedReason, 'inadimplência');
  assert.equal(out.lastLoginIp, '203.0.113.9');
  assert.equal(out.termsVersion, 1);
  assert.ok(out.createdAt);
  assert.ok(out.updatedAt);
});

test('serializeAdminUser: normaliza ausências e null', () => {
  const out = serializeAdminUser({ id: 'u', name: 'Só Nome', email: 'x@y.z' });
  assert.equal(out.avatar, '');
  assert.equal(out.role, 'user');
  assert.equal(out.status, 'active');
  assert.equal(out.accountRestricted, false);
  assert.equal(out.restrictedReason, null);
  assert.equal(out.lastLogin, null);
  assert.equal(out.lastLoginIp, null);
});

test('serializeAdminUserList: mapeia a lista sem vazar nada', () => {
  const list = serializeAdminUserList([FAT_USER, { id: 'u2', name: 'B', email: 'b@c.d' }]);
  assert.equal(list.length, 2);
  assert.equal('password' in list[0], false);
  assert.equal(list[1].name, 'B');
});

test('serializeAdminUser(null) e listas inválidas são seguras', () => {
  assert.equal(serializeAdminUser(null), null);
  assert.deepEqual(serializeAdminUserList(undefined), []);
  assert.deepEqual(serializeAdminUserList('nao-array'), []);
});