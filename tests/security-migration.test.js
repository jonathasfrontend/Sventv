'use strict';

/**
 * Prisma Migration Test: verifica que a migration
 * 20260922120000_add_google_auth aplicou corretamente os campos
 * googleId e authProvider na tabela users.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// ── Migration file exists and has correct structure ──────────

test('migration: arquivo SQL existe', () => {
  const migrationPath = path.join(
    __dirname, '..', 'prisma', 'migrations', '20260922120000_add_google_auth', 'migration.sql'
  );
  assert.ok(fs.existsSync(migrationPath), 'migration.sql deve existir');
  const sql = fs.readFileSync(migrationPath, 'utf8');
  assert.ok(
    sql.includes('google_id') || sql.includes('googleId'),
    'SQL deve incluir google_id/googleId'
  );
  assert.ok(
    sql.includes('auth_provider') || sql.includes('authProvider'),
    'SQL deve incluir auth_provider/authProvider'
  );
});

test('migration: arquivo meta.prisma existe', () => {
  const metaPath = path.join(
    __dirname, '..', 'prisma', 'migrations', '20260922120000_add_google_auth', 'meta.prisma'
  );
  assert.ok(fs.existsSync(metaPath), 'meta.prisma deve existir');
});

test('migration: SQL adiciona googleId como campo', () => {
  const migrationPath = path.join(
    __dirname, '..', 'prisma', 'migrations', '20260922120000_add_google_auth', 'migration.sql'
  );
  const sql = fs.readFileSync(migrationPath, 'utf8');
  assert.ok(
    sql.includes('google_id') || sql.includes('googleId'),
    'googleId deve estar na migration'
  );
  assert.ok(
    sql.includes('ALTER') || sql.includes('ADD COLUMN') || sql.includes('CREATE INDEX'),
    'deve ter ALTER TABLE/ADD COLUMN/CREATE INDEX'
  );
});

test('migration: SQL adiciona authProvider como campo', () => {
  const migrationPath = path.join(
    __dirname, '..', 'prisma', 'migrations', '20260922120000_add_google_auth', 'migration.sql'
  );
  const sql = fs.readFileSync(migrationPath, 'utf8');
  assert.ok(
    sql.includes('auth_provider') || sql.includes('authProvider'),
    'authProvider deve estar na migration'
  );
  assert.ok(
    sql.includes('ALTER') || sql.includes('ADD COLUMN') || sql.includes('CREATE INDEX'),
    'deve ter ALTER TABLE/ADD COLUMN/CREATE INDEX'
  );
});

// ── Prisma schema: campos existem ────────────────────────────

test('schema.prisma: User model tem googleId', () => {
  const schemaPath = path.join(__dirname, '..', 'prisma', 'schema.prisma');
  const schema = fs.readFileSync(schemaPath, 'utf8');
  assert.ok(schema.includes('googleId'), 'schema deve ter googleId no model User');
});

test('schema.prisma: User model tem authProvider', () => {
  const schemaPath = path.join(__dirname, '..', 'prisma', 'schema.prisma');
  const schema = fs.readFileSync(schemaPath, 'utf8');
  assert.ok(schema.includes('authProvider'), 'schema deve ter authProvider no model User');
});

test('schema.prisma: googleId é unique ou nullable', () => {
  const schemaPath = path.join(__dirname, '..', 'prisma', 'schema.prisma');
  const schema = fs.readFileSync(schemaPath, 'utf8');
  const userModelMatch = schema.match(/model User\s*\{[\s\S]*?\n\}/);
  assert.ok(userModelMatch, 'model User deve existir');
  const userBlock = userModelMatch[0];
  const googleIdLine = userBlock.split('\n').find((l) => l.includes('googleId'));
  assert.ok(googleIdLine, 'googleId deve estar no model User');
  assert.ok(
    googleIdLine.includes('unique') || googleIdLine.includes('?'),
    'googleId deve ser unique ou nullable'
  );
});

// ── Schema consistency: campo no model tem no migration ──────

test('consistência: campos no schema estão na migration', () => {
  const schemaPath = path.join(__dirname, '..', 'prisma', 'schema.prisma');
  const migrationPath = path.join(
    __dirname, '..', 'prisma', 'migrations', '20260922120000_add_google_auth', 'migration.sql'
  );
  const schema = fs.readFileSync(schemaPath, 'utf8');
  const migration = fs.readFileSync(migrationPath, 'utf8');

  const schemaHasGoogle = schema.includes('googleId') || schema.includes('google_id');
  const schemaHasAuth = schema.includes('authProvider') || schema.includes('auth_provider');
  const migrationHasGoogle = migration.includes('googleId') || migration.includes('google_id');
  const migrationHasAuth = migration.includes('authProvider') || migration.includes('auth_provider');

  assert.ok(schemaHasGoogle, 'schema tem googleId/google_id');
  assert.ok(schemaHasAuth, 'schema tem authProvider/auth_provider');
  assert.ok(migrationHasGoogle, 'migration tem googleId/google_id');
  assert.ok(migrationHasAuth, 'migration tem authProvider/auth_provider');
});
