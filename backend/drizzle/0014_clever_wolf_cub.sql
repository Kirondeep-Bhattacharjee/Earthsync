ALTER TABLE "messages" DROP CONSTRAINT "messages_content";--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "low_delivered_at" timestamp;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "high_delivered_at" timestamp;--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "waveform" smallint[];--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "deleted_for_everyone_at" timestamp;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "show_read_receipts" boolean DEFAULT true NOT NULL;--> statement-breakpoint
CREATE INDEX "messages_deleted_idx" ON "messages" USING btree ("deleted_for_everyone_at") WHERE "messages"."deleted_for_everyone_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_waveform_size" CHECK ("media"."waveform" IS NULL OR cardinality("media"."waveform") BETWEEN 1 AND 100);--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_content" CHECK ("messages"."deleted_for_everyone_at" IS NOT NULL OR ("messages"."kind" = 'text' AND ("messages"."body" IS NOT NULL OR "messages"."body_enc" IS NOT NULL)) OR ("messages"."kind" <> 'text' AND "messages"."media_id" IS NOT NULL));