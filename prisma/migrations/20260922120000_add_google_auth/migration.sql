-- migration.sql
-- Adiciona google_id e auth_provider à tabela users (autenticação Google OAuth)
-- Migration: 20260922120000_add_google_auth
-- NÃO é retroativa: usuários existentes manterão google_id=NULL, auth_provider='local'

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "google_id" VARCHAR(255);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "auth_provider" VARCHAR(32) DEFAULT 'local';
CREATE INDEX "users_google_id_idx" ON "users" ("google_id");
CREATE INDEX "users_auth_provider_idx" ON "users" ("auth_provider");
