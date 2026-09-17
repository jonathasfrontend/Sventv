-- CreateTable
CREATE TABLE "channel_health" (
    "channel_id" VARCHAR(255) NOT NULL,
    "active_source" VARCHAR(20) NOT NULL,
    "consecutive_fails" INTEGER NOT NULL DEFAULT 0,
    "last_switch_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "channel_health_pkey" PRIMARY KEY ("channel_id")
);