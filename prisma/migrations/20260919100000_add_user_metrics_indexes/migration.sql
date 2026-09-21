-- Métricas de usuários no painel admin (2026-09-19)
-- Índices para as consultas agregadas do userMetricsService:
--   - users.created_at: série/growth por janela (getUserGrowth/Series)
--   - watch_history.last_played_at: DISTINCT de engajamento (getEngagementSnapshot)
-- Ambas são aditivas e não destrutivas.

CREATE INDEX "users_created_at_idx" ON "users" ("created_at");
CREATE INDEX "watch_history_lastplayed_idx" ON "watch_history" ("last_played_at");