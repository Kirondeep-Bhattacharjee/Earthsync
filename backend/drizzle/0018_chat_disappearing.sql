ALTER TABLE "conversations" ADD COLUMN "disappear_after_seconds" integer;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "expires_at" timestamp;--> statement-breakpoint
CREATE INDEX "messages_expires_idx" ON "messages" USING btree ("expires_at") WHERE "messages"."expires_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_disappear_positive" CHECK ("conversations"."disappear_after_seconds" IS NULL OR "conversations"."disappear_after_seconds" > 0);