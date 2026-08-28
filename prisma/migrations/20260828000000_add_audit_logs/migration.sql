-- Tabela de auditoria: registra operações sensíveis (login, logout,
-- troca de senha, criação/revogação de API token, admin, playback).
-- userId é nullable e SEM FK para que registros sobrevivam à exclusão
-- de usuários. Nunca guarda tokens/segredos.

CREATE TABLE "audit_logs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "action" VARCHAR(80) NOT NULL,
  "user_id" UUID,
  "email" VARCHAR(255),
  "ip" VARCHAR(64),
  "user_agent" VARCHAR(512),
  "request_id" VARCHAR(64),
  "channel_id" VARCHAR(255),
  "meta" JSONB,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "audit_logs_user_idx" ON "audit_logs"("user_id");
CREATE INDEX "audit_logs_action_idx" ON "audit_logs"("action");
CREATE INDEX "audit_logs_created_idx" ON "audit_logs"("created_at");
