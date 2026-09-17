-- CreateTable
CREATE TABLE "channel_states" (
    "channel_id" VARCHAR(255) NOT NULL,
    "state" VARCHAR(20) NOT NULL,
    "reason" VARCHAR(255) NOT NULL DEFAULT '',
    "set_by" VARCHAR(255),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "channel_states_pkey" PRIMARY KEY ("channel_id")
);

-- CreateIndex
CREATE INDEX "channel_states_state_updated_idx" ON "channel_states"("state", "updated_at");