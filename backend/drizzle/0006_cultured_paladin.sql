ALTER TABLE "conversations" ADD COLUMN "low_read_at" timestamp;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "high_read_at" timestamp;--> statement-breakpoint
UPDATE "conversations" SET "low_read_at" = now(), "high_read_at" = now();