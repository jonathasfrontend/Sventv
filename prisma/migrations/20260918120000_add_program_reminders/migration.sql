-- CreateTable
CREATE TABLE "program_reminders" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "channel_id" VARCHAR(255) NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "stop_at" TIMESTAMPTZ(6),
    "notified_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "program_reminders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "program_reminders_user_start_idx" ON "program_reminders"("user_id", "starts_at");

-- CreateIndex
CREATE INDEX "program_reminders_due_idx" ON "program_reminders"("starts_at", "notified_at");

-- CreateIndex
CREATE UNIQUE INDEX "program_reminders_user_channel_start_unique" ON "program_reminders"("user_id", "channel_id", "starts_at");

-- AddForeignKey
ALTER TABLE "program_reminders" ADD CONSTRAINT "program_reminders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;