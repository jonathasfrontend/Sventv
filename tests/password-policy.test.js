'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Joi = require('joi');

const {
  isValidPassword,
  exceedsBcryptLimit,
  passwordPolicyErrors,
  MIN_LENGTH,
  MAX_BYTES,
} = require('../src/utils/passwordPolicy');
const { schemas } = require('../src/middlewares/validate');

// ── passwordPolicy.js (puro, sem DB/Redis) ──────────────────────

test('MIN_LENGTH = 8, MAX_BYTES = 72', () => {
  assert.equal(MIN_LENGTH, 8);
  assert.equal(MAX_BYTES, 72);
});

test('isValidPassword aceita senha válida (8 chars)', () => {
  assert.equal(isValidPassword('Ab1defg!'), true);
});

test('isValidPassword rejeita < 8 caracteres', () => {
  assert.equal(isValidPassword('Ab1cde!'), false);
});

test('isValidPassword rejeita sem minúscula', () => {
  assert.equal(isValidPassword('ABCD1234'), false);
});

test('isValidPassword rejeita sem maiúscula', () => {
  assert.equal(isValidPassword('abcd1234'), false);
});

test('isValidPassword rejeita sem número', () => {
  assert.equal(isValidPassword('Abcdefgh'), false);
});

test('exceedsBcryptLimit rejeita 73+ bytes UTF-8 (conta bytes, não chars)', () => {
  // 'a' = 1 byte; 72 a's = OK, 73 a's = excede
  assert.equal(exceedsBcryptLimit('a'.repeat(72)), false);
  assert.equal(exceedsBcryptLimit('a'.repeat(73)), true);
});

test('exceedsBcryptLimit aceita 72 bytes com multibyte (acentos)', () => {
  // 'é' = 2 bytes UTF-8; 36×'é' = 72 bytes
  assert.equal(exceedsBcryptLimit('é'.repeat(36)), false);
  assert.equal(exceedsBcryptLimit('é'.repeat(37)), true);  // 74 bytes
});

test('passwordPolicyErrors retorna array vazio para senha válida', () => {
  const errs = passwordPolicyErrors('Ab1cd!ef');
  assert.equal(errs.length, 0);
});

test('passwordPolicyErrors retorna todos os erros (mínimo 8)', () => {
  const errs = passwordPolicyErrors('A1');
  assert.ok(errs.length >= 2);
  assert.ok(errs.some(e => e.includes('8')));
});

// ── Joi schemas (validação de INPUT) ─────────────────────────────

test('register schema: aceita payload completo válido', () => {
  const { error, value } = schemas.register.validate({
    name: 'João Silva',
    email: 'joao@example.com',
    password: 'Senha123!',
    confirmPassword: 'Senha123!',
    acceptedTerms: true,
  }, { abortEarly: false });
  assert.ok(!error, 'payload válido deveria passar');
  assert.equal(value.email, 'joao@example.com');
  // Campos do schema permanecem (o controller repassa ao service).
  assert.equal(value.confirmPassword, 'Senha123!');
  assert.equal(value.acceptedTerms, true);
});

test('register schema: rejeita confirmPassword diferente', () => {
  const { error } = schemas.register.validate({
    name: 'João',
    email: 'joao@example.com',
    password: 'Senha123!',
    confirmPassword: 'Senha124!',
    acceptedTerms: true,
  }, { abortEarly: false });
  const confirmErr = error?.details?.find(d => d.path.includes('confirmPassword'));
  assert.ok(confirmErr, 'Deveria ter erro de confirmPassword');
  assert.match(confirmErr.message, /coincidem/);
});

test('register schema: rejeita acceptedTerms = false', () => {
  const { error } = schemas.register.validate({
    name: 'João',
    email: 'joao@example.com',
    password: 'Senha123!',
    confirmPassword: 'Senha123!',
    acceptedTerms: false,
  }, { abortEarly: false });
  const termsErr = error?.details?.find(d => d.path.includes('acceptedTerms'));
  assert.ok(termsErr, 'Deveria ter erro de acceptedTerms');
  assert.match(termsErr.message, /Termos/);
});

test('register schema: rejeita acceptedTerms = "true" (string, não booleano)', () => {
  const { error } = schemas.register.validate({
    name: 'João',
    email: 'joao@example.com',
    password: 'Senha123!',
    confirmPassword: 'Senha123!',
    acceptedTerms: 'true',
  }, { abortEarly: false });
  const termsErr = error?.details?.find(d => d.path.includes('acceptedTerms'));
  assert.ok(termsErr);
});

test('register schema: rejeita senha com 73 bytes', () => {
  const { error } = schemas.register.validate({
    name: 'Teste',
    email: 't@t.com',
    password: 'a'.repeat(72) + 'B1!',   // 75 bytes = 75 chars ASCII
    confirmPassword: 'a'.repeat(72) + 'B1!',
    acceptedTerms: true,
  }, { abortEarly: false });
  const passErr = error?.details?.find(d => d.path.includes('password'));
  assert.ok(passErr, 'Deveria ter erro de senha por bytes exceder 72');
});

test('forgotPassword schema: aceita e-mail válido', () => {
  const { error } = schemas.forgotPassword.validate({ email: 'x@y.com' });
  assert.ok(!error);
});

test('resetPassword schema: aceita código de 6 dígitos', () => {
  const { error } = schemas.resetPassword.validate({
    email: 'x@y.com',
    code: '123456',
    newPassword: 'NovaSenha1!',
    confirmPassword: 'NovaSenha1!',
  });
  assert.ok(!error);
});

test('resetPassword schema: rejeita código com letras', () => {
  const { error } = schemas.resetPassword.validate({
    email: 'x@y.com',
    code: '12345A',
    newPassword: 'NovaSenha1!',
    confirmPassword: 'NovaSenha1!',
  });
  assert.ok(error);
});

test('resetPassword schema: rejeita newPassword < 8 caracteres', () => {
  const { error } = schemas.resetPassword.validate({
    email: 'x@y.com',
    code: '123456',
    newPassword: 'Ab1!',
    confirmPassword: 'Ab1!',
  }, { abortEarly: false });
  const err = error?.details?.find(d => d.path.includes('newPassword'));
  assert.ok(err);
  assert.match(err.message, /8 caracteres/);
});