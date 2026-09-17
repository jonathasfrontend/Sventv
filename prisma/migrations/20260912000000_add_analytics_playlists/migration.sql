-- Migration: Analytics, Playback Sessions, Histórico, Playlists e Métricas
-- (2026-09-12)

-- ── playback_sessions ──────────────────────────────────────────
-- Uma linha por player aberto. O id `session_id` é gerado no cliente
-- (UUID) e é único. Heartbeats atualizam apenas esta linha; transições
-- discretas viram linhas em playback_events.
CREATE TABLE "playback_sessions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "session_id" VARCHAR(80) NOT NULL,
  "user_id" UUID NOT NULL,
  "channel_id" VARCHAR(255) NOT NULL,
  "channel_name" VARCHAR(255),
  "channel_logo" VARCHAR(512),
  "channel_category" VARCHAR(120),
  "status" VARCHAR(20) NOT NULL DEFAULT 'active',
  "started_at" TIMESTAMPTZ(6) NOT NULL,
  "last_heartbeat_at" TIMESTAMPTZ(6),
  "paused_at" TIMESTAMPTZ(6),
  "ended_at" TIMESTAMPTZ(6),
  "watch_duration_ms" BIGINT NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "playback_sessions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "playback_sessions_session_id_key" ON "playback_sessions"("session_id");
CREATE INDEX "playback_sessions_user_hb_idx" ON "playback_sessions"("user_id", "last_heartbeat_at");
CREATE INDEX "playback_sessions_user_started_idx" ON "playback_sessions"("user_id", "started_at");
CREATE INDEX "playback_sessions_channel_started_idx" ON "playback_sessions"("channel_id", "started_at");
CREATE INDEX "playback_sessions_channel_user_idx" ON "playback_sessions"("channel_id", "user_id");
CREATE INDEX "playback_sessions_status_hb_idx" ON "playback_sessions"("status", "last_heartbeat_at");

ALTER TABLE "playback_sessions"
  ADD CONSTRAINT "playback_sessions_user_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── playback_events ───────────────────────────────────────────
-- Apenas eventos discretos (play/pause/resume/stop/ended). Não grava
-- heartbeat — mantém o volume de linhas controlável.
CREATE TABLE "playback_events" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "session_id" VARCHAR(80) NOT NULL,
  "user_id" UUID NOT NULL,
  "channel_id" VARCHAR(255) NOT NULL,
  "event" VARCHAR(20) NOT NULL,
  "watch_duration_ms" BIGINT NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "playback_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "playback_events_user_created_idx" ON "playback_events"("user_id", "created_at");
CREATE INDEX "playback_events_channel_created_idx" ON "playback_events"("channel_id", "created_at");
CREATE INDEX "playback_events_created_idx" ON "playback_events"("created_at");
CREATE INDEX "playback_events_session_idx" ON "playback_events"("session_id");

ALTER TABLE "playback_events"
  ADD CONSTRAINT "playback_events_session_fkey"
  FOREIGN KEY ("session_id") REFERENCES "playback_sessions"("session_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "playback_events"
  ADD CONSTRAINT "playback_events_user_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── watch_history ─────────────────────────────────────────────
-- Histórico consolidado: 1 linha por (user, channel). Replay consolida.
CREATE TABLE "watch_history" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "channel_id" VARCHAR(255) NOT NULL,
  "channel_name" VARCHAR(255),
  "channel_logo" VARCHAR(512),
  "channel_category" VARCHAR(120),
  "play_count" INTEGER NOT NULL DEFAULT 0,
  "sessions_count" INTEGER NOT NULL DEFAULT 0,
  "total_watch_ms" BIGINT NOT NULL DEFAULT 0,
  "last_played_at" TIMESTAMPTZ(6) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "watch_history_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "watch_history_user_channel_unique" ON "watch_history"("user_id", "channel_id");
CREATE INDEX "watch_history_user_lastplayed_idx" ON "watch_history"("user_id", "last_played_at");

ALTER TABLE "watch_history"
  ADD CONSTRAINT "watch_history_user_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── playlists ─────────────────────────────────────────────────
CREATE TABLE "playlists" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "name" VARCHAR(80) NOT NULL,
  "description" VARCHAR(280) NOT NULL DEFAULT '',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "playlists_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "playlists_user_created_idx" ON "playlists"("user_id", "created_at");

ALTER TABLE "playlists"
  ADD CONSTRAINT "playlists_user_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── playlist_channels ─────────────────────────────────────────
-- userId é denormalizado para garantir no banco a regra crítica:
-- UM canal só pode pertencer a UMA playlist por usuário.
CREATE TABLE "playlist_channels" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "playlist_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "channel_id" VARCHAR(255) NOT NULL,
  "channel_name" VARCHAR(255),
  "channel_logo" VARCHAR(512),
  "channel_category" VARCHAR(120),
  "position" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "playlist_channels_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "playlist_channels_plist_channel_unique" ON "playlist_channels"("playlist_id", "channel_id");
CREATE UNIQUE INDEX "playlist_channels_user_channel_unique" ON "playlist_channels"("user_id", "channel_id");
CREATE INDEX "playlist_channels_plist_pos_idx" ON "playlist_channels"("playlist_id", "position");

ALTER TABLE "playlist_channels"
  ADD CONSTRAINT "playlist_channels_playlist_fkey"
  FOREIGN KEY ("playlist_id") REFERENCES "playlists"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "playlist_channels"
  ADD CONSTRAINT "playlist_channels_user_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── channel_metrics ───────────────────────────────────────────
-- Agregação diária por canal (idempotente, alimentada por job).
CREATE TABLE "channel_metrics" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "channel_id" VARCHAR(255) NOT NULL,
  "channel_name" VARCHAR(255),
  "channel_category" VARCHAR(120),
  "date" DATE NOT NULL,
  "views" INTEGER NOT NULL DEFAULT 0,
  "unique_viewers" INTEGER NOT NULL DEFAULT 0,
  "sessions" INTEGER NOT NULL DEFAULT 0,
  "total_watch_ms" BIGINT NOT NULL DEFAULT 0,
  "avg_session_duration_ms" BIGINT NOT NULL DEFAULT 0,
  "peak_concurrent" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "channel_metrics_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "channel_metrics_channel_date_unique" ON "channel_metrics"("channel_id", "date");
CREATE INDEX "channel_metrics_date_idx" ON "channel_metrics"("date");
CREATE INDEX "channel_metrics_cat_date_idx" ON "channel_metrics"("channel_category", "date");

-- ── user_metrics ──────────────────────────────────────────────
-- Agregação diária por usuário (área administrativa).
CREATE TABLE "user_metrics" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "date" DATE NOT NULL,
  "sessions" INTEGER NOT NULL DEFAULT 0,
  "views" INTEGER NOT NULL DEFAULT 0,
  "total_watch_ms" BIGINT NOT NULL DEFAULT 0,
  "channels_count" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "user_metrics_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "user_metrics_user_date_unique" ON "user_metrics"("user_id", "date");
CREATE INDEX "user_metrics_date_idx" ON "user_metrics"("date");

ALTER TABLE "user_metrics"
  ADD CONSTRAINT "user_metrics_user_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;