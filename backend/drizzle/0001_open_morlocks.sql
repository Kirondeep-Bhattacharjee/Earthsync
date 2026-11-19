ALTER TABLE "users" DROP CONSTRAINT "users_phone_number_unique";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "profile_picture_key" varchar(255);--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "phone_number";