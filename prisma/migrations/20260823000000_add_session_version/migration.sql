-- Adiciona session_version: contador incrementado no logout/troca de senha.
-- JWTs de sessão carregam o claim `sv`; sessões antigas são rejeitadas
-- quando o valor do banco é maior (revogação server-side de todas as
-- sessões ativas do usuário).

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "session_version" INTEGER NOT NULL DEFAULT 0;
