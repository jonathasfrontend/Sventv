'use strict';

/**
 * Schemas Joi das rotas admin de usuários (src/middlewares/validate.js):
 *  - whitelist contra mass assignment (campos fora do schema são removidos);
 *  - política de senha reutilizada (adminChangePassword);
 *  - exclusão exige confirmação literal `confirm: true`.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { schemas } = require('../src/middlewares/validate');

function fail(value, schemaName) {
  const { error } = schemas[schemaName].validate(value, { abortEarly: false, stripUnknown: true });
  return error !== undefined;
}

test('adminUpdateProfile: campos não permitidos são descartados (stripUnknown)', () => {
  const { value } = schemas.adminUpdateProfile.validate(
    { name: 'Ana', role: 'admin', password: 'hack', status: 'banned', planCode: 'premium' },
    { abortEarly: false, stripUnknown: true }
  );
  assert.deepEqual(value, { name: 'Ana' });
});

test('adminUpdateProfile: exige ao menos um campo válido', () => {
  assert.ok(fail({}, 'adminUpdateProfile'));
  assert.ok(!fail({ name: 'Ana' }, 'adminUpdateProfile'));
  assert.ok(!fail({ email: 'ana@example.com' }, 'adminUpdateProfile'));
  assert.ok(fail({ email: 'nao-eh-email' }, 'adminUpdateProfile'));
  assert.ok(fail({ name: 'A' }, 'adminUpdateProfile'));
});

test('adminChangePassword: exige política de senha e confirmação idêntica', () => {
  const good = { newPassword: 'SenhaForte123', confirmPassword: 'SenhaForte123' };
  assert.ok(!fail(good, 'adminChangePassword'));
  assert.ok(fail({ ...good, confirmPassword: 'Outra456' }, 'adminChangePassword'));
  assert.ok(fail({ ...good, newPassword: 'fraca' }, 'adminChangePassword'));
  assert.ok(fail({ ...good, newPassword: 'SemNumero' }, 'adminChangePassword'));
});

test('adminDeleteUser: confirm deve ser literalmente true', () => {
  assert.ok(!fail({ confirm: true }, 'adminDeleteUser'));
  assert.ok(fail({ confirm: false }, 'adminDeleteUser'));
  assert.ok(fail({}, 'adminDeleteUser'));
  assert.ok(fail({ confirm: 'sim' }, 'adminDeleteUser'));
  assert.ok(fail({ confirm: 1 }, 'adminDeleteUser'));
});