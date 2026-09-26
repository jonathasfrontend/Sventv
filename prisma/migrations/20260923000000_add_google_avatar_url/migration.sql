-- migration.sql
-- Adiciona google_avatar_url à tabela users (fonte da imagem do Google,
-- separada do avatar personalizado/externo gravado em `avatar`).
--
-- Por que uma coluna separada: a migração para avatar por URL externa
-- precisa preservar a imagem do Google mesmo depois que o usuário define
-- (e depois remove) um avatar personalizado. O campo `avatar` guarda o
-- avatar PERSONALIZADO; `google_avatar_url` guarda apenas o picture do
-- Google. O avatar EFETIVO exibido passa a ser `avatar || google_avatar_url`.
--
-- Migration: 20260923000000_add_google_avatar_url
-- NÃO é retroativa para dados: usuários já existentes mantêm o avatar atual
-- em `avatar` (não há como saber a origem sem migração de dados especulativa).

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "google_avatar_url" TEXT;