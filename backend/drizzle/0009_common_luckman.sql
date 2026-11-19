CREATE TYPE "public"."consent_kind" AS ENUM('age_confirmation', 'terms_privacy');--> statement-breakpoint
CREATE TABLE "account_private" (
	"user_id" integer PRIMARY KEY NOT NULL,
	"date_of_birth" date NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "consents" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"kind" "consent_kind" NOT NULL,
	"version" varchar(20) NOT NULL,
	"accepted_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account_private" ADD CONSTRAINT "account_private_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "consents_user_kind_version_idx" ON "consents" USING btree ("user_id","kind","version");