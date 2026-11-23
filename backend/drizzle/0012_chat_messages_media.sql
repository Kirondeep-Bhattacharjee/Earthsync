CREATE TYPE "public"."message_kind" AS ENUM('text', 'image', 'voice');--> statement-breakpoint
ALTER TYPE "public"."media_type" ADD VALUE 'audio';--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT "messages_body_not_empty";--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "body" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "retention_hold" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "sha256" varchar(64);--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "kind" "message_kind" DEFAULT 'text' NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "body_enc" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "key_version" smallint;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "media_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_media_id_unique" UNIQUE("media_id");--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_content" CHECK (("messages"."kind" = 'text' AND ("messages"."body" IS NOT NULL OR "messages"."body_enc" IS NOT NULL)) OR ("messages"."kind" <> 'text' AND "messages"."media_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_enc_has_version" CHECK ("messages"."body_enc" IS NULL OR "messages"."key_version" IS NOT NULL);