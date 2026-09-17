-- Migration: Recuperação de Senha + Aceite de Termos de Uso
-- (2026-09-16)

-- ── users: termos de uso ──────────────────────────────────────
-- Registra QUANDO (`terms_accepted_at`) e QUAL versão (`terms_version`)
-- o usuário aceitou. Nada de booleano solto: precisamos da rastreabilidade.
ALTER TABLE "users"
  ADD COLUMN "terms_accepted_at" TIMESTAMPTZ(6),
  ADD COLUMN "terms_version" VARCHAR(32);

-- ── password_reset_codes ──────────────────────────────────────
-- Código de recuperação de 6 dígitos por e-mail.
-- NUNCA armazena o código puro: apenas SHA-256 (`code_hash`, hex 64).
-- Consumo único via `used_at`; expira em `expires_at`; contador de
-- tentativas em `attempts` (máx. configurável, 5 por padrão).
CREATE TABLE "password_reset_codes" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "code_hash" VARCHAR(64) NOT NULL,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "used_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "password_reset_codes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "password_reset_codes_user_created_idx" ON "password_reset_codes"("user_id", "created_at");

ALTER TABLE "password_reset_codes"
  ADD CONSTRAINT "password_reset_codes_user_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;