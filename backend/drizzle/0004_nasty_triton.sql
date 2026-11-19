-- profiles.username becomes the one public, unique username. users.username is
-- kept only as the sign-up seed, so it stops being unique.
--
-- How to apply: run `npm run db:generate`, then replace the contents of the
-- generated drizzle/0004_*.sql with this file (keep the generated snapshot),
-- then run `npm run db:migrate`.

-- 1. Add the column as nullable so existing rows survive.
ALTER TABLE "profiles" ADD COLUMN "username" varchar(30);--> statement-breakpoint

-- 2. Profiles used to be created lazily: give every user without one a row.
INSERT INTO "profiles" ("user_id")
SELECT u."id" FROM "users" u
WHERE NOT EXISTS (SELECT 1 FROM "profiles" p WHERE p."user_id" = u."id");--> statement-breakpoint

-- 3. Backfill. Accounts created through Google only (no password) got their
--    username from the email, so they get a random one instead; everyone else
--    keeps the name they chose at sign-up. Delete the CASE if you would rather
--    keep the old names.
UPDATE "profiles" p
SET "username" = CASE
    WHEN u."password_hash" IS NULL
        THEN 'user_' || substr(md5(random()::text || u."id"::text), 1, 8)
    ELSE u."username"
END
FROM "users" u
WHERE u."id" = p."user_id" AND p."username" IS NULL;--> statement-breakpoint

-- 4. Lock it down.
ALTER TABLE "profiles" ALTER COLUMN "username" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_username_unique" UNIQUE ("username");--> statement-breakpoint

-- 5. The seed no longer needs to be unique (this is what frees up old seeds).
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_username_unique";