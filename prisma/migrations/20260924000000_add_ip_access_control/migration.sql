-- migration.sql
-- WAF / IP Access Control: captura o IP de cadastro em `users.registration_ip`
-- e cria a tabela `ip_blocklist` (blocklist administrativa persistente de IPs).
--
-- Arquitetura:
--   * `registration_ip` (NULL p/ usuários antigos — nunca inventar IP) guarda
--     o IP real coletado NO CADASTRO (backend-side, nunca confiável do front).
--   * `ip_blocklist` é UMA linha por IP (PK natural): `active` marca o estado
--     atual (true = bloqueado; false após unblock, preservando histórico),
--     `blocked_by`/`unblocked_by` guardam o e-mail do admin que agiu.
--   * Sem FK para `users`: IPs são compartilhados entre contas — o bloqueio é
--     decisão sobre o endereço, atinge (registro e login) todos que o usarem.
--
-- Migration: 20260924000000_add_ip_access_control
-- NÃO é retroativa para dados: usuários existentes ficam com registration_ip
-- NULL (o IP do cadastro original não existe em lugar nenhum).

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "registration_ip" VARCHAR(64);

CREATE TABLE IF NOT EXISTS "ip_blocklist" (
  "ip" VARCHAR(64) NOT NULL,
  "reason" VARCHAR(255) NOT NULL DEFAULT '',
  "blocked_by" VARCHAR(255),
  "blocked_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "unblocked_by" VARCHAR(255),
  "unblocked_at" TIMESTAMPTZ(6),
  "active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "ip_blocklist_pkey" PRIMARY KEY ("ip")
);

CREATE INDEX IF NOT EXISTS "ip_blocklist_active_idx" ON "ip_blocklist" ("active");

CREATE INDEX IF NOT EXISTS "users_registration_ip_idx" ON "users" ("registration_ip");