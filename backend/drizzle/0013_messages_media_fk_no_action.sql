ALTER TABLE "messages" DROP CONSTRAINT "messages_media_id_media_id_fk";
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE no action ON UPDATE no action;