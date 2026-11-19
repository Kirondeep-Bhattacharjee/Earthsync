# EarthSync (Sync): Project Handoff

> **For the AI assistant reading this:** This file captures everything decided and built so far on the EarthSync app (brand name in the UI: **Sync**). Treat it as the source of truth. Match the code conventions in section 11 when adding anything. Items under "Pending / next steps" are not built yet. Code marked "written, not yet run" was produced in chat and has not been confirmed working. No real secret values have been shared; only variable names appear below.

Last updated: 2026-11-09

---

## 0. Changes since the previous checkpoint (2026-11-09)

1. **Step 4 built (user search), backend and frontend.**
   - Backend: new `routes/users.ts` with `GET /api/users/search?q=` (section 5). Authenticated; prefix match on `profiles.username`; public and private profiles both appear; excludes the viewer and anyone blocked in either direction (one `NOT EXISTS` subquery on `blocks`); 20 results ordered by username; 60 searches per minute per user. Returns only `{ username, visibility, profilePictureUrl }` (never email, never bio).
   - Frontend: new page `/connect` (`Pages/connect.tsx`) and `UserListSkeleton` (section 6). Each result links to `/u/:username`.
   - Confirmed: from the browser console the endpoint returned results (prefix `solo` found `solo` and `solomusic`), and the Connect page rendered results. A relative `/api/...` call from the Vite origin (`localhost:5173`) returns the app's HTML because there is no Vite proxy, so console tests must use the backend URL (`http://localhost:3000/api/...`).
2. **Decision change: the public username lives in `profiles`; display name is removed.** Testing showed search matched `users.username`, which Google sign-up had generated from the email's local part, while the profile page edited the display name. Two problems followed: search and editing pointed at different fields, and the email-derived handle exposed part of people's email addresses. Rules now:
   - `users` is identity and auth only. `users.username` is a **sign-up seed**: copied into `profiles.username` when the account is created, then never read for display, search or sign-in. It is no longer unique.
   - `profiles.username` is **NOT NULL and UNIQUE** and is the only public name: search, `/u/:username`, the `@handle`, sign-in by username, and what `/auth/me` returns. Input is always lowercased, so `Sam` and `sam` cannot both exist.
   - Every account gets its `profiles` row **at sign-up, in the same transaction as the `users` row** (manual and Google). Profile routes are update-only; `GET /api/profile` returns 404 if the row is missing (cannot happen after the migration).
   - **Google sign-up gets a random username** (`user_` + 8 hex chars, `generateUsername()` in `lib/username.ts`), never derived from the email or Google name. People rename themselves on the profile page.
   - Renaming goes through `PUT /api/profile` (`username` field): 409 with a `username` field error when taken; limited to 5 changes per hour per user (the limiter skips requests that don't include a username). A short-lived separate route `PUT /api/users/me/username` was written and then **deleted**; do not use it.
   - **Display name is gone** from the UI and from every API response and the update schema. The `profiles.display_name` column still exists but is unused (drop it in a later migration).
   - Email is only ever returned by `/auth/me` to the signed-in user. Search, `/api/profile` and `/api/profile/:username` never select it.
3. **Migration 0004 applied and verified in Neon (2026-11-09).** Hand-written SQL (section 4): add `profiles.username`, create missing profile rows, backfill, `NOT NULL` + `UNIQUE`, drop `users_username_unique`. Result: 5 users and 5 profiles; the password account (`kirondeep1`) kept its name, the four Google-only accounts got random `user_xxxxxxxx` names (this includes the test accounts `solo`, `solomusic` and `kirondeep`).
4. **Frontend changes.** `Pages/profile.tsx` now edits **username and bio** (display name removed), shows `@username` as the heading, reads the username from the profile response, and calls `useAuth().refresh()` after a rename so the sidebar updates. `Pages/user-profile.tsx` header is `@username` only. New `Pages/connect.tsx` (step 4).
5. **Verification status.** Type-checked against stubs of the project (backend routes, profile page, user-profile page, connect page; no errors apart from stub limitations) and the migration was run against a throwaway Postgres with old-style data. Confirmed in the real app: the sidebar and `/auth/me` show the profile username, the Neon backfill result, search results render. **Not yet tested:** renaming from the new Edit form (including the 409 and the hourly limit), the private-profile view from a second account, and block exclusion in search (needs `blocks` rows).
6. **R2 403 still open.** After adding the hotspot IP to the token's allow-list the 403 came back: a hotspot's public IP (IPv4 and IPv6) changes whenever the carrier reassigns it, so an IP allow-list keeps breaking in development. See section 7.
7. **Next:** step 5 (friend requests), then step 6 (block/unblock).

---

## 0a. Earlier checkpoint (2026-11-06, kept for context)

1. **Step 3 built (profile visibility and viewing other users), backend and frontend.**
   - Backend: new `lib/relationships.ts` (`isBlockedEitherWay`, `areFriends`, `getRelationship`); `routes/profile.ts` now reads and writes `visibility`; new `GET /api/profile/:username` (section 5).
   - Frontend: new page `/u/:username` (`Pages/user-profile.tsx`), `VisibilityToggle`, `UserProfileSkeleton`; the toggle is wired into `Pages/profile.tsx` and the route into `App.tsx` (section 6). Needs the shadcn `switch` and `badge` components.
   - The toggle was redesigned after feedback: its heading, description and icon now show the current state ("Your profile is private/public"), the switch moves immediately and rolls back on error, and a "Saving…/Saved" status shows.
2. **Decision change: private profiles ARE searchable.** A non-friend can send **one message** until both users are friends (mutual). A non-friend sees only the header of a private profile (name, picture), not the bio. Later, posts and feeds will also be hidden from non-friends (section 10).
3. **Agreed build order for the friend graph:** (3) visibility + viewing others, (4) user search, (5) friend requests, (6) block/unblock, each backend piece followed by its UI before moving on. Steps 3 and 4 are done; step 5 is next.
4. **Status notes (superseded):** migration 0003 is confirmed applied (section 4). The R2 403 (section 7) is still open.

---

## 1. What the app is

- Social/profile-style app (dating-app-style profiles are the inspiration), now heading toward a **basic chat MVP**.
- Client flow: user signs up or logs in, can edit their profile (username, bio, profile picture), then (planned) find people, send friend requests, and chat 1:1.
- **MVP profile:** profile image + bio + username (the public handle). There is no separate display name any more.
- **Profile visibility (decided):** `public` or `private`. Both appear in search. A private profile shows only the header (name, picture) to non-friends; friends and the owner see everything. Non-friends can send one message until both are friends. Posts and feeds (later) will be hidden from non-friends the same way.
- **Ideas still being thought through (not decided):** Spotify connection for favorite artists/music sections, question prompts.
- Users will later upload **media: images and videos** (stored in Cloudflare R2). Plan to limit video duration and later add ffmpeg compression.

## 2. Tech stack

### Backend

| Area | Choice |
|---|---|
| Runtime / language | Node.js, TypeScript 7, ESM (`"type": "module"`, relative imports end in `.js`) |
| Server | Express 5 (async handler rejections are forwarded automatically; routes still use try/catch + `handleError`) |
| Validation | zod 4 |
| ORM | Drizzle ORM 0.45 + drizzle-kit 0.31 |
| Database | Neon (serverless Postgres) via `@neondatabase/serverless` + `ws` (WebSocket driver, supports transactions) |
| Auth | `express-session` cookie sessions (cookie name `sync.sid`), bcrypt (12 rounds), Google Sign-In via `google-auth-library` |
| Session store | `connect-pg-simple` on a small dedicated `pg.Pool` (max 5, plain TCP on port 5432), table `session`, expired rows pruned hourly |
| File storage | Cloudflare R2 (bucket `earthsync`) via `@aws-sdk/client-s3` |
| Uploads / images | `multer` (memory storage) + `sharp` (decode, rotate, resize, WebP, strips EXIF) |
| Rate limiting | `express-rate-limit` |
| Dev runner | `tsx watch src/server.ts` (does not reload `.env`; restart after env changes) |
| Domain | `earthsync.space` (bought, active on Cloudflare free plan) |

Existing deps: `cors`, `dotenv`, `pg`, `connect-pg-simple` (the last two for the session store; their `@types` packages were not confirmed). Dev types: `@types/express`, `@types/express-session`, `@types/bcrypt`, `@types/cors`, `@types/ws`, `@types/node`, plus `@types/multer`.

**Packages added for avatars (installed; the server runs the avatar routes):** `@aws-sdk/client-s3`, `multer`, `sharp`, `express-rate-limit`, `@types/multer`. The presigner package is **not** needed for avatars (only for the future video flow).

**npm scripts:** `dev`, `db:generate`, `db:migrate`, `db:push`, `db:studio`. There is no `build` or `start` script yet.

### Frontend

| Area | Choice |
|---|---|
| Framework | React + Vite + TypeScript |
| Routing | `react-router-dom` (`BrowserRouter`, nested layout routes) |
| UI | shadcn/ui + Tailwind (theme tokens like `primary`, `muted`, `destructive`, `card`) |
| Icons | `@tabler/icons-react` |
| Google sign-in | `@react-oauth/google` (`GoogleOAuthProvider`, client id from `VITE_GOOGLE_CLIENT_ID`) |
| Theme | `ThemeProvider` (default dark, storageKey `vite-ui-theme`), `ModeToggle` |
| Auth state | `AuthProvider` + `useAuth()` from `@/lib/auth` (exposes `user` with `id`, `username`, `email`; also `loading`, `refresh` and `signOut`). `user.username` is the profile's username; `refresh()` re-reads `/auth/me` and is called after a rename so the sidebar updates |
| Dev server | `http://localhost:5173` |

Frontend env vars: `VITE_GOOGLE_CLIENT_ID`, `VITE_API_URL` (leave empty if using a Vite dev proxy for `/api`).

shadcn components in use: `sidebar` (existing), plus `avatar`, `card`, `input`, `label`, `textarea`, `button`, `skeleton`, `switch`, `badge` (install with `npx shadcn@latest add avatar card input label textarea button skeleton switch badge`).

## 3. Folder structure (known / created files)

```
backend/src/
  server.ts                  (entry; starts app)
  app.ts                     (Express app setup)
  db/
    index.ts                 (exports `db`)
    schema.ts                (Drizzle tables)
  lib/
    http.ts                  (HttpError, validationError, handleError, uniqueViolation)
    username.ts              (usernameSchema, generateUsername; the one username rule)
    r2.ts                    (R2 client, avatar put/delete, key generation)
    session.ts               (connect-pg-simple store + shared sessionMiddleware; exports sessionStore, SESSION_COOKIE_NAME)
    relationships.ts         (isBlockedEitherWay, areFriends, getRelationship; reused by search, requests, blocks)
  middlewares/
    requireAuth.ts
  routes/
    auth.ts                  (sign-up, sign-in, google, sign-out, me)
    profile.ts               (GET/PUT /profile, GET /profile/:username, POST/DELETE /profile/avatar)
    users.ts                 (GET /users/search)
    dashboard.ts             (mounted with requireAuth; contents not shared)

frontend/src/
  App.tsx                    (routes; see section 6)
  Pages/                     (home, sign_in, sign_up, dashboard, profile, user-profile, connect)
  components/
    Navbar.tsx               (public layout)
    ProtectedRoute.tsx       (waits for auth check, redirects to /sign-in)
    SyncLayout.tsx           (SidebarProvider + AppSidebar + header with SidebarTrigger/ModeToggle + <Outlet/>)
    app-sidebar.tsx          (nav groups: Social, Account, Help; user footer; sign out)
    skeletons/
      page-skeleton.tsx      (generic loading fallback)
      profile-skeleton.tsx   (mirrors the profile page layout)
      user-profile-skeleton.tsx (mirrors Pages/user-profile.tsx)
      user-list-skeleton.tsx   (mirrors the result list on Pages/connect.tsx)
    visibility-toggle.tsx    (private/public switch, saves immediately)
    ui/                      (shadcn components)
  lib/auth                   (AuthProvider, useAuth)
```

## 4. Database schema

`phone_number` was **removed** from `users`. Profile data lives in a separate 1:1 `profiles` table (userId is both PK and FK). `profiles.username` is the public, unique username (migration 0004); `users.username` is only the sign-up seed. Since the checkpoint before last the schema also gained profile visibility, the friend graph (`friend_requests`, `friendships`, `blocks`) and the `session` table. A `media` table is defined for future images/videos.

Migrations: `npm run db:generate` then `npm run db:migrate` (needs outbound port 5432, see section 9).

- **0003** (friend graph, visibility, session table): applied and confirmed; all tables exist.
- **0004** (profile username): applied and verified in Neon on 2026-11-09. drizzle-kit's generated SQL would fail on existing rows (a `NOT NULL` column with no backfill), so the generated `drizzle/0004_*.sql` was replaced by hand-written SQL (keep the generated snapshot). Constraint names: `profiles_username_unique`, `users_email_unique`; `users_username_unique` was dropped.

```sql
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
```

Current schema (after 0004):

```typescript
import {
    pgTable,
    pgEnum,
    serial,
    integer,
    bigint,
    uuid,
    varchar,
    boolean,
    json,
    timestamp,
    index,
    uniqueIndex,
    primaryKey,
    check,
} from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"

/* ------------------------------------------------------------------ */
/* Users (identity and auth only)                                      */
/* ------------------------------------------------------------------ */

export const users = pgTable(
    "users",
    {
        id: serial("id").primaryKey(),
        // Sign-up seed only: copied into profiles.username when the account is
        // created, never shown or searched. Not unique, so an old seed can't
        // block a name that nobody can see. profiles.username is the real one.
        username: varchar("username", { length: 50 }).notNull(),
        email: varchar("email", { length: 255 }).notNull().unique(),
        emailVerified: boolean("email_verified").notNull().default(false),
        passwordHash: varchar("password_hash", { length: 255 }), // null for Google-only users
        googleId: varchar("google_id", { length: 255 }).unique(), // null for password-only users
        createdAt: timestamp("created_at").defaultNow().notNull(),
    },
    (t) => [
        check(
            "has_auth_method",
            sql`${t.passwordHash} IS NOT NULL OR ${t.googleId} IS NOT NULL`
        ),
    ]
)

/* ------------------------------------------------------------------ */
/* Profiles (1:1 with users, userId is both PK and FK)                 */
/* ------------------------------------------------------------------ */

// Every account gets a profile row at sign-up (same transaction as the user).
// profiles.username is the only public, unique username: search, /u/:username
// and the UI all use it.
//
// public:  appears in search; anyone (not blocked) can view the full profile and send a request.
// private: also appears in search, but non-friends see the header only (name, picture).
//          Until you are friends, a non-friend can send one message (enforced in chat later).
export const profileVisibility = pgEnum("profile_visibility", [
    "public",
    "private",
])

export const profiles = pgTable(
    "profiles",
    {
        userId: integer("user_id")
            .primaryKey()
            .references(() => users.id, { onDelete: "cascade" }),
        username: varchar("username", { length: 30 }).notNull().unique(),
        displayName: varchar("display_name", { length: 50 }),
        bio: varchar("bio", { length: 500 }),
        profilePictureKey: varchar("profile_picture_key", { length: 255 }), // R2 object key, null = no picture
        visibility: profileVisibility("visibility").notNull().default("public"),
        createdAt: timestamp("created_at").defaultNow().notNull(),
        updatedAt: timestamp("updated_at")
            .defaultNow()
            .notNull()
            .$onUpdate(() => new Date()),
    },
    (t) => [index("profiles_visibility_idx").on(t.visibility)]
)

/* ------------------------------------------------------------------ */
/* Friend requests (pending only: a row is deleted when it is resolved) */
/* ------------------------------------------------------------------ */

// One shared table. "Incoming" = rows where receiver_id is me, "outgoing" =
// rows where sender_id is me. Accept: delete the row and insert a friendship in
// one transaction. Decline (receiver) and cancel (sender): just delete the row.
export const friendRequests = pgTable(
    "friend_requests",
    {
        id: serial("id").primaryKey(),
        senderId: integer("sender_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        receiverId: integer("receiver_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        createdAt: timestamp("created_at").defaultNow().notNull(),
    },
    (t) => [
        check("friend_requests_not_self", sql`${t.senderId} <> ${t.receiverId}`),
        // Only one pending request per pair, in either direction (A->B blocks B->A).
        // If drizzle-kit rejects this expression index, create it in a custom migration:
        //   CREATE UNIQUE INDEX friend_requests_pair_idx ON friend_requests
        //   (LEAST(sender_id, receiver_id), GREATEST(sender_id, receiver_id));
        uniqueIndex("friend_requests_pair_idx").on(
            sql`least(${t.senderId}, ${t.receiverId})`,
            sql`greatest(${t.senderId}, ${t.receiverId})`
        ),
        index("friend_requests_receiver_idx").on(t.receiverId, t.createdAt),
        index("friend_requests_sender_idx").on(t.senderId, t.createdAt),
    ]
)

/* ------------------------------------------------------------------ */
/* Friendships (one row per pair, ids stored in order: low < high)     */
/* ------------------------------------------------------------------ */

// The app must always store the smaller user id in userLowId. The check
// constraint rejects the wrong order, and the unique index stops duplicates,
// so a pair can never be friends twice. Later, messages reference friendships.id.
export const friendships = pgTable(
    "friendships",
    {
        id: serial("id").primaryKey(),
        userLowId: integer("user_low_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        userHighId: integer("user_high_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        createdAt: timestamp("created_at").defaultNow().notNull(),
    },
    (t) => [
        check("friendships_ordered", sql`${t.userLowId} < ${t.userHighId}`),
        uniqueIndex("friendships_pair_idx").on(t.userLowId, t.userHighId),
        // The unique index above covers lookups by userLowId; this covers userHighId.
        index("friendships_high_idx").on(t.userHighId),
    ]
)

/* ------------------------------------------------------------------ */
/* Blocks (directional: blocker -> blocked)                            */
/* ------------------------------------------------------------------ */

// A block in either direction hides the two users from each other. Blocking
// also deletes any friendship and pending requests between them (in one
// transaction). Unblocking only removes this row; it does not restore anything.
export const blocks = pgTable(
    "blocks",
    {
        blockerId: integer("blocker_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        blockedId: integer("blocked_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        createdAt: timestamp("created_at").defaultNow().notNull(),
    },
    (t) => [
        primaryKey({ columns: [t.blockerId, t.blockedId] }),
        check("blocks_not_self", sql`${t.blockerId} <> ${t.blockedId}`),
        // The primary key covers "who have I blocked"; this covers "who blocked me".
        index("blocks_blocked_idx").on(t.blockedId),
    ]
)

/* ------------------------------------------------------------------ */
/* Media (images and videos stored in R2) - not used by avatars        */
/* ------------------------------------------------------------------ */

export const mediaType = pgEnum("media_type", ["image", "video"])
export const mediaStatus = pgEnum("media_status", [
    "pending", // presigned URL issued, upload not confirmed yet
    "processing", // uploaded, waiting on or running ffmpeg/ffprobe
    "ready", // safe to serve
    "failed",
])

export const media = pgTable(
    "media",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        userId: integer("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        key: varchar("key", { length: 255 }).notNull().unique(), // R2 object key
        type: mediaType("type").notNull(),
        contentType: varchar("content_type", { length: 100 }).notNull(),
        sizeBytes: bigint("size_bytes", { mode: "number" }),
        durationSeconds: integer("duration_seconds"), // videos only
        status: mediaStatus("status").notNull().default("pending"),
        createdAt: timestamp("created_at").defaultNow().notNull(),
    },
    (t) => [index("media_user_id_idx").on(t.userId)]
)

/* ------------------------------------------------------------------ */
/* Sessions (managed by connect-pg-simple, never queried via Drizzle)  */
/* ------------------------------------------------------------------ */

// Column names and types must match what connect-pg-simple expects.
export const session = pgTable(
    "session",
    {
        sid: varchar("sid").primaryKey(),
        sess: json("sess").notNull(),
        expire: timestamp("expire", { precision: 6 }).notNull(),
    },
    (t) => [index("IDX_session_expire").on(t.expire)]
)
```

**Design decisions**
- **Store the R2 object key, not the full URL.** The public URL is built at read time: `${R2_PUBLIC_URL}/${key}`. Changing domains later is an env change, not a data migration.
- Avatars live on `profiles.profilePictureKey` (no `media` row). The `media` table is **not used by avatars** and can be deferred until image/video posts are built.
- Future many-per-user things (favorite artists, prompt answers) get **their own tables**, not columns on `profiles`.
- **Spotify OAuth tokens (if added) go in their own table**, never on `profiles`.
- Profile rows are created **at sign-up, in the same transaction as the user** (manual and Google), so every account has one. `GET /profile` returns 404 if it is missing; `PUT /profile` and the avatar routes only update.
- **Username:** `profiles.username` (NOT NULL, UNIQUE, lowercased, `^[a-z0-9_]{3,30}$`, one shared `usernameSchema` in `lib/username.ts`) is the only public name. `users.username` is a sign-up seed (copied into `profiles`, not unique, never displayed, searched or used for sign-in). Google sign-up seeds a random `user_xxxxxxxx`. A unique violation on `profiles_username_unique` means "username taken".
- **No display name.** `profiles.display_name` is an unused leftover column; remove it in a later migration.
- Deleting a user cascades to profile and media rows but does **not** delete R2 objects (cleanup logic needed later).
- **Profile visibility** (`public` default / `private`) lives on `profiles`. Read and written through `/api/profile`, enforced by `GET /api/profile/:username`, and toggled in the profile page. Both values appear in search. (The `profileVisibility` comment in `schema.ts` now states this rule.)
- **Friend requests are pending-only** and separate from friendships (replaces the earlier idea of one `friendships` table with a status column). One pending request per pair in either direction, enforced by an expression unique index on `least/greatest` of the two ids.
- **Friendships store one row per pair** with `userLowId < userHighId` (check constraint + unique pair index). Application code must put the smaller id first.
- **Blocks are directional** (`blocks` composite PK); a block in either direction hides both users from each other. Blocking must delete the friendship and pending requests in one transaction; unblocking restores nothing.
- The `session` table is owned by `connect-pg-simple`; its column names and types must stay as defined above.

## 5. Backend behavior

### Routes and final URLs
Routers are mounted at `/api` in `app.ts`; each route file declares its full sub-path.

| Method | URL | Notes |
|---|---|---|
| GET | `/health` | `{ ok: true }` |
| POST | `/api/auth/sign-up` | username, email, password; creates the user and its profile in one transaction (the username is copied into `profiles.username`), then the session |
| POST | `/api/auth/sign-in` | `identifier` (profile username or email) + password |
| POST | `/api/auth/google` | body `{ credential }` (Google ID token); finds/links/creates user; new users get a random `user_xxxxxxxx` username and a profile row |
| POST | `/api/auth/sign-out` | destroys session, clears `sync.sid` cookie |
| GET | `/api/auth/me` | requires auth; returns `{ authenticated, user }` with `user = { id, username (the profile's), email }`. The only place email is returned |
| GET | `/api/profile` | requires auth; returns `{ profile }`; 404 if the profile row is missing |
| PUT | `/api/profile` | requires auth; partial update (`username`, `bio`, `visibility`), update-only. A taken username is 409 with a `username` field error; username changes are limited to 5 per hour per user |
| GET | `/api/profile/:username` | requires auth; another user's profile, see below |
| GET | `/api/users/search?q=` | requires auth; username prefix search, see below |
| POST | `/api/profile/avatar` | requires auth; multipart field `avatar`; upload or replace picture |
| DELETE | `/api/profile/avatar` | requires auth; removes picture (idempotent) |
| any | `/api/dashboard/*` | mounted behind `requireAuth` |

Own-profile responses use the shape `{ username, bio, visibility, profilePictureUrl }` (the key is converted to a URL via `R2_PUBLIC_URL`).

`GET /api/profile/:username` returns `{ user: { username, bio, visibility, profilePictureUrl }, relationship, canViewFullProfile }`:
- `relationship` is `self | friend | request_sent | request_received | none` (from the viewer's point of view).
- Blocked in either direction, an unknown username, or a malformed username all return **404 "User not found"**, so a block never reveals that an account exists.
- `canViewFullProfile` is true for public profiles, friends and self. For a private profile viewed by a non-friend, `bio` is `null` and `canViewFullProfile` is false. Future posts and feeds should check the same flag.
- Usernames are validated with the shared `usernameSchema` (`^[a-z0-9_]{3,30}$`, lowercased) and looked up in `profiles.username`.

### `GET /api/users/search?q=` (step 4)
- Authenticated and rate limited (60 per minute per user). `q` is trimmed, lowercased, a leading `@` is dropped; a query that can never match a username (spaces, `.`, `@` inside) returns `{ users: [] }`; an empty or missing `q` is 400.
- Prefix match on `profiles.username` (`LIKE 'abc%'` with `_`, `%` and `\` escaped, since `_` is legal in usernames), ordered by username, limited to 20.
- Includes public and private profiles. Excludes the viewer and anyone blocked in either direction (`NOT EXISTS` subquery on `blocks`).
- Response: `{ users: [{ username, visibility, profilePictureUrl }] }`. Never email, never bio. Relationship is not returned (kept minimal; `/u/:username` has it).

### `app.ts` mounting

```typescript
import profileRouter from "./routes/profile.js";
import usersRouter from "./routes/users.js";
import { sessionMiddleware } from "./lib/session.js";
// ...
app.use(sessionMiddleware); // Postgres-backed sessions, config in lib/session.ts
app.use("/api", authRouter);
app.use("/api", profileRouter);
app.use("/api", usersRouter);
app.use("/api/dashboard", requireAuth, dashboardRouter);
```

Existing `app.ts` setup: `dotenv/config`, CORS (`credentials: true`, origin `CLIENT_ORIGIN ?? "http://localhost:5173"`), JSON + urlencoded parsing, the shared `sessionMiddleware` from `lib/session.ts` (cookie settings now live there, see below), `trust proxy` = 1 in production, `/health`, a JSON 404 handler, and a catch-all JSON error handler (`entity.parse.failed` becomes 400; anything else is logged as `Unhandled error:` and returns 500, which is how session-store connection failures show up in the console).

### `backend/src/lib/session.ts` (running)

Replaces the in-memory store. Throws at import time if `SESSION_SECRET` or `DATABASE_URL` is missing.

```typescript
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import pg from "pg";

// Must match SESSION_COOKIE_NAME in routes/auth.ts
export const SESSION_COOKIE_NAME = "sync.sid";

const sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) throw new Error("SESSION_SECRET is not configured");

const connectionString = process.env.DATABASE_URL; // same variable db/index.ts reads
if (!connectionString) throw new Error("DATABASE_URL is not configured");

const isProduction = process.env.NODE_ENV === "production";

const PgSession = connectPgSimple(session);

// Small dedicated pool over plain TCP (port 5432): sessions are simple queries,
// so this keeps the Neon WebSocket driver out of it.
const pool = new pg.Pool({ connectionString, max: 5 });

// Exported so the WebSocket server can look up a session from its cookie later.
export const sessionStore = new PgSession({
    pool,
    tableName: "session", // created by the Drizzle migration
    pruneSessionInterval: 60 * 60, // hourly, so an idle Neon DB isn't woken for housekeeping
});

// Shared by Express and the future WebSocket upgrade handler.
export const sessionMiddleware = session({
    store: sessionStore,
    name: SESSION_COOKIE_NAME,
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true, // push expiry forward on every request
    cookie: {
        httpOnly: true,
        secure: isProduction,
        sameSite: "lax",
        maxAge: 24 * 60 * 60 * 1000, // 24 hrs
    },
});
```

Important: this pool connects over **plain TCP on port 5432**, so it fails on networks that block that port (section 9).

### Auth details worth knowing
- `req.session.userId` holds the user id; session ID is regenerated on login (session fixation protection).
- `publicUser` selection is `{ id: users.id, username: profiles.username, email: users.email }` (never leaks `passwordHash`); every query that builds it joins `profiles`. Read the username from `profiles`, never from `users`.
- Sign-in uses a dummy bcrypt hash compare to avoid timing leaks; Google-only accounts are told to use Google sign-in.
- Google flow: verifies the ID token, requires a verified email; links to an existing account by email (dropping the password on previously unverified accounts); otherwise creates the user and its profile in one transaction with a random `generateUsername()` (`user_` + 8 hex chars, retried on collision), never derived from the email or Google name.
- Sign-up creates the `users` row and the `profiles` row in one transaction (`createUserWithProfile`). Sign-in matches `users.email` (identifier contains `@`) or `profiles.username` (join).
- Postgres unique violations (`23505`) are mapped to 409 via `uniqueViolation()`, now exported from `lib/http.ts` (shared by auth, profile). `fieldFromConstraint` maps constraint names containing `username`, `email` or `google` to a field.
- Password limits: 8-72 chars. Username: shared `usernameSchema` (`^[a-z0-9_]{3,30}$`, lowercased).
- `routes/auth.ts` imports `HttpError`, `handleError`, `uniqueViolation`, `validationError` from `../lib/http.js` and `generateUsername`, `usernameSchema` from `../lib/username.js`.

### `backend/src/lib/http.ts`

```typescript
import type { Response } from "express";
import { z } from "zod";

export class HttpError extends Error {
    status: number;

    constructor(status: number, message: string) {
        super(message);
        this.status = status;
    }
}

export function validationError(res: Response, error: z.ZodError) {
    return res.status(400).json({
        message: "Invalid input",
        errors: error.issues.map((issue) => ({
            field: issue.path.join("."),
            message: issue.message,
        })),
    });
}

export function handleError(res: Response, error: unknown, label: string) {
    if (error instanceof HttpError) {
        return res.status(error.status).json({ message: error.message });
    }

    console.error(`${label} error:`, error);
    return res
        .status(500)
        .json({ message: "An internal server error occurred" });
}

// Returns the violated constraint name for a Postgres unique violation (23505),
// or null if the error is something else. Checks `cause` because newer Drizzle
// versions wrap driver errors.
export function uniqueViolation(error: unknown): string | null {
    const e = error as {
        code?: string;
        constraint?: string;
        cause?: { code?: string; constraint?: string };
    };

    const code = e?.code ?? e?.cause?.code;
    if (code !== "23505") {
        return null;
    }

    return e?.constraint ?? e?.cause?.constraint ?? "unknown";
}
```

### `backend/src/lib/username.ts`

One username rule for sign-up, profile edits, search-adjacent lookups and `/u/:username`. Lowercasing here is what makes usernames case-insensitive in practice.

```typescript
import { randomBytes } from "node:crypto";
import { z } from "zod";

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

// One rule for every place a username is typed: sign-up, profile edits and
// the /u/:username lookup. Lowercasing here is what makes "Sam" and "sam" the
// same name, so the unique constraint on profiles.username is case-insensitive
// in practice.
export const usernameSchema = z
    .string()
    .trim()
    .toLowerCase()
    .regex(
        /^[a-z0-9_]{3,30}$/,
        "Username must be 3-30 characters: letters, numbers and underscores only"
    );

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

// Default name for accounts that did not pick one (Google sign-up). Random on
// purpose: nothing about the person or their email may appear in a public name.
export function generateUsername(): string {
    return `user_${randomBytes(4).toString("hex")}`;
}
```

### `backend/src/lib/relationships.ts`

Shared helpers for steps 4 to 6. Friendships store the smaller id first, so lookups use `Math.min/Math.max`.

```typescript
import { and, eq, or } from "drizzle-orm";
import { db } from "../db/index.js";
import { blocks, friendRequests, friendships } from "../db/schema.js";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

// How the viewer stands with another user, from the viewer's point of view.
export type Relationship =
    | "self"
    | "friend"
    | "request_sent" // the viewer sent a pending request
    | "request_received" // the other user sent the viewer a pending request
    | "none";

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

// True if either user has blocked the other. Callers treat both directions
// the same way: the two users must not see each other.
export async function isBlockedEitherWay(a: number, b: number): Promise<boolean> {
    const [row] = await db
        .select({ blockerId: blocks.blockerId })
        .from(blocks)
        .where(
            or(
                and(eq(blocks.blockerId, a), eq(blocks.blockedId, b)),
                and(eq(blocks.blockerId, b), eq(blocks.blockedId, a))
            )
        )
        .limit(1);

    return row !== undefined;
}

// Friendships store the smaller id first, so the lookup must do the same.
export async function areFriends(a: number, b: number): Promise<boolean> {
    const [row] = await db
        .select({ id: friendships.id })
        .from(friendships)
        .where(
            and(
                eq(friendships.userLowId, Math.min(a, b)),
                eq(friendships.userHighId, Math.max(a, b))
            )
        )
        .limit(1);

    return row !== undefined;
}

export async function getRelationship(
    viewerId: number,
    targetId: number
): Promise<Relationship> {
    if (viewerId === targetId) {
        return "self";
    }

    if (await areFriends(viewerId, targetId)) {
        return "friend";
    }

    // At most one pending request exists per pair (unique index), in either direction.
    const [request] = await db
        .select({ senderId: friendRequests.senderId })
        .from(friendRequests)
        .where(
            or(
                and(
                    eq(friendRequests.senderId, viewerId),
                    eq(friendRequests.receiverId, targetId)
                ),
                and(
                    eq(friendRequests.senderId, targetId),
                    eq(friendRequests.receiverId, viewerId)
                )
            )
        )
        .limit(1);

    if (!request) {
        return "none";
    }

    return request.senderId === viewerId ? "request_sent" : "request_received";
}
```

### `backend/src/lib/r2.ts` (running; currently hitting an R2 403, see section 7)

```typescript
import {
    DeleteObjectCommand,
    PutObjectCommand,
    S3Client,
} from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";
import { HttpError } from "./http.js";

/* ------------------------------------------------------------------ */
/* Client                                                              */
/* ------------------------------------------------------------------ */

const accountId = process.env.R2_ACCOUNT_ID;
const accessKeyId = process.env.R2_ACCESS_KEY_ID;
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
const bucket = process.env.R2_BUCKET;

const AVATAR_PREFIX = "avatars/";

const client =
    accountId && accessKeyId && secretAccessKey
        ? new S3Client({
              region: "auto",
              endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
              credentials: { accessKeyId, secretAccessKey },
              // R2 doesn't support the SDK's newer default checksums.
              requestChecksumCalculation: "WHEN_REQUIRED",
              responseChecksumValidation: "WHEN_REQUIRED",
          })
        : null;

function requireStorage() {
    if (!client || !bucket) {
        console.error("R2 is not configured: check the R2_* env vars");
        throw new HttpError(503, "File storage is not available");
    }

    return { client, bucket };
}

/* ------------------------------------------------------------------ */
/* Avatars                                                             */
/* ------------------------------------------------------------------ */

// A new key on every upload means the old image is never overwritten, so the
// CDN can cache each file forever and a failed DB update can't corrupt anything.
// Ownership is tracked by the profiles row, not by the path.
export function createAvatarKey(): string {
    return `${AVATAR_PREFIX}${randomUUID()}.webp`;
}

export async function putAvatar(key: string, body: Buffer): Promise<void> {
    const storage = requireStorage();

    await storage.client.send(
        new PutObjectCommand({
            Bucket: storage.bucket,
            Key: key,
            Body: body,
            ContentType: "image/webp",
            CacheControl: "public, max-age=31536000, immutable",
        })
    );
}

// Best-effort: a failed delete only leaves an unused file behind, so it is
// logged and never thrown. The user must not see an error because of it.
export async function deleteAvatar(key: string): Promise<void> {
    // Never delete anything outside the avatars folder, whatever the DB holds.
    if (!key.startsWith(AVATAR_PREFIX)) {
        console.error(`Refusing to delete non-avatar key: ${key}`);
        return;
    }

    try {
        const storage = requireStorage();

        await storage.client.send(
            new DeleteObjectCommand({ Bucket: storage.bucket, Key: key })
        );
    } catch (error) {
        console.error(`R2 delete failed for ${key}:`, error);
    }
}
```

### `backend/src/routes/profile.ts` (written 2026-11-09, type-checked, not yet run end to end; username in `profiles`, no display name, update-only; avatar routes need the R2 fix, see section 7)

```typescript
import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import { eq } from "drizzle-orm";
import multer from "multer";
import sharp from "sharp";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { db } from "../db/index.js";
import { profiles } from "../db/schema.js";
import { requireAuth } from "../middlewares/requireAuth.js";
import {
    HttpError,
    handleError,
    uniqueViolation,
    validationError,
} from "../lib/http.js";
import { createAvatarKey, deleteAvatar, putAvatar } from "../lib/r2.js";
import { getRelationship, isBlockedEitherWay } from "../lib/relationships.js";
import { usernameSchema } from "../lib/username.js";

const router = Router();

const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL;

const AVATAR_MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const AVATAR_SIZE = 512; // stored as a 512x512 square
// Rejects decompression bombs: a tiny file that expands to a huge bitmap.
const AVATAR_MAX_INPUT_PIXELS = 50_000_000;

// Columns that are safe to send to the client.
const publicProfile = {
    username: profiles.username,
    bio: profiles.bio,
    profilePictureKey: profiles.profilePictureKey,
    visibility: profiles.visibility,
};

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

// Trims, turns "" into null (so the user can clear a field), and leaves
// the field untouched when it is missing from the request.
function optionalText(max: number, label: string) {
    return z
        .string()
        .trim()
        .max(max, `${label} must be at most ${max} characters`)
        .transform((value) => (value === "" ? null : value))
        .nullable()
        .optional();
}

// Unknown keys are stripped, so a client can never set profilePictureKey
// through this route. That is only done by the avatar routes below.
const updateProfileSchema = z
    .object({
        username: usernameSchema.optional(),
        bio: optionalText(500, "Bio"),
        visibility: z.enum(["public", "private"]).optional(),
    })
    .refine(
        (data) => Object.values(data).some((value) => value !== undefined),
        { message: "Provide at least one field to update" }
    );

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

type ProfileRow = {
    username: string;
    bio: string | null;
    profilePictureKey: string | null;
    visibility: "public" | "private";
};

function toResponse(profile: ProfileRow) {
    return {
        username: profile.username,
        bio: profile.bio,
        visibility: profile.visibility,
        profilePictureUrl:
            profile.profilePictureKey && R2_PUBLIC_URL
                ? `${R2_PUBLIC_URL}/${profile.profilePictureKey}`
                : null,
    };
}

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: AVATAR_MAX_BYTES, files: 1 },
});

// Runs multer and turns its errors into the same JSON shape as the rest of the API.
function receiveAvatar(req: Request, res: Response, next: NextFunction) {
    upload.single("avatar")(req, res, (error: unknown) => {
        if (!error) {
            next();
            return;
        }

        if (error instanceof multer.MulterError) {
            if (error.code === "LIMIT_FILE_SIZE") {
                res.status(413).json({ message: "Image must be 5 MB or smaller" });
                return;
            }

            res.status(400).json({ message: "Invalid upload" });
            return;
        }

        handleError(res, error, "Avatar upload");
    });
}

// Decodes the file (so non-images fail here, whatever the client claimed),
// applies the EXIF rotation, crops to a square and re-encodes as WebP.
// sharp drops all metadata (including GPS location) unless asked to keep it.
async function processAvatar(input: Buffer): Promise<Buffer> {
    try {
        return await sharp(input, { limitInputPixels: AVATAR_MAX_INPUT_PIXELS })
            .rotate()
            .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: "cover" })
            .webp({ quality: 82 })
            .toBuffer();
    } catch {
        throw new HttpError(400, "That file isn't a valid image");
    }
}

// Per user, not per IP, and only on the expensive route.
const avatarUploadLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => String(req.session.userId ?? "anonymous"),
    message: { message: "Too many uploads. Try again in a few minutes." },
});

// Renaming breaks old profile links, so keep it slow. Edits that don't touch
// the username (bio, visibility) skip the limit.
const usernameChangeLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 5,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => String(req.session.userId ?? "anonymous"),
    skip: (req) =>
        (req.body as { username?: unknown } | undefined)?.username === undefined,
    message: { message: "Too many username changes. Try again later." },
});

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

// Every account gets a profile row at sign-up, so a missing row is a 404.
router.get("/profile", requireAuth, async (req, res) => {
    const userId = req.session.userId;

    if (userId === undefined) {
        return res.status(401).json({ message: "Not authenticated" });
    }

    try {
        const [profile] = await db
            .select(publicProfile)
            .from(profiles)
            .where(eq(profiles.userId, userId))
            .limit(1);

        if (!profile) {
            throw new HttpError(404, "Profile not found");
        }

        return res.status(200).json({ profile: toResponse(profile) });
    } catch (error) {
        return handleError(res, error, "Get profile");
    }
});

// Partial update. The username is the public handle that search and profile
// links use; it must stay unique, so a taken name is a 409 on that field.
router.put(
    "/profile",
    requireAuth,
    usernameChangeLimiter,
    async (req, res) => {
        const userId = req.session.userId;

        if (userId === undefined) {
            return res.status(401).json({ message: "Not authenticated" });
        }

        const parsed = updateProfileSchema.safeParse(req.body);

        if (!parsed.success) {
            return validationError(res, parsed.error);
        }

        const updates = parsed.data;

        try {
            const [profile] = await db
                .update(profiles)
                .set({ ...updates, updatedAt: new Date() })
                .where(eq(profiles.userId, userId))
                .returning(publicProfile);

            if (!profile) {
                throw new HttpError(404, "Profile not found");
            }

            return res.status(200).json({
                message: "Profile updated",
                profile: toResponse(profile),
            });
        } catch (error) {
            // The username is the only unique column an update can touch.
            if (uniqueViolation(error)) {
                return res.status(409).json({
                    message: "That username is taken",
                    errors: [
                        { field: "username", message: "That username is taken" },
                    ],
                });
            }

            return handleError(res, error, "Update profile");
        }
    }
);

// View another user's profile.
// - Blocked in either direction: 404, so a block never reveals that the account exists.
// - Public profile, or a friend, or yourself: full profile.
// - Private profile and not a friend: header only (name, picture), bio hidden.
//   Later, posts and feeds follow the same canViewFullProfile flag.
router.get("/profile/:username", requireAuth, async (req, res) => {
    const viewerId = req.session.userId;

    if (viewerId === undefined) {
        return res.status(401).json({ message: "Not authenticated" });
    }

    // A malformed username can never exist, so it is a 404.
    const username = usernameSchema.safeParse(req.params.username);

    if (!username.success) {
        return res.status(404).json({ message: "User not found" });
    }

    try {
        const [target] = await db
            .select({ id: profiles.userId, ...publicProfile })
            .from(profiles)
            .where(eq(profiles.username, username.data))
            .limit(1);

        if (!target) {
            return res.status(404).json({ message: "User not found" });
        }

        const [blocked, relationship] = await Promise.all([
            isBlockedEitherWay(viewerId, target.id),
            getRelationship(viewerId, target.id),
        ]);

        if (blocked) {
            return res.status(404).json({ message: "User not found" });
        }

        const canViewFullProfile =
            target.visibility === "public" ||
            relationship === "friend" ||
            relationship === "self";

        const profile = toResponse(target);

        return res.status(200).json({
            user: {
                ...profile,
                bio: canViewFullProfile ? profile.bio : null,
            },
            relationship,
            canViewFullProfile,
        });
    } catch (error) {
        return handleError(res, error, "Get user profile");
    }
});

// Upload or replace the profile picture (multipart form, field name "avatar").
router.post(
    "/profile/avatar",
    requireAuth,
    avatarUploadLimiter,
    receiveAvatar,
    async (req, res) => {
        const userId = req.session.userId;

        if (userId === undefined) {
            return res.status(401).json({ message: "Not authenticated" });
        }

        if (!req.file) {
            return res.status(400).json({ message: "Choose an image to upload" });
        }

        try {
            const processed = await processAvatar(req.file.buffer);
            const newKey = createAvatarKey();

            // Upload first: if this fails, nothing in the database has changed.
            await putAvatar(newKey, processed);

            let previousKey: string | null = null;
            let profile;

            try {
                const [previous] = await db
                    .select({ key: profiles.profilePictureKey })
                    .from(profiles)
                    .where(eq(profiles.userId, userId))
                    .limit(1);

                if (!previous) {
                    throw new HttpError(404, "Profile not found");
                }

                previousKey = previous.key;

                [profile] = await db
                    .update(profiles)
                    .set({ profilePictureKey: newKey, updatedAt: new Date() })
                    .where(eq(profiles.userId, userId))
                    .returning(publicProfile);

                if (!profile) {
                    throw new Error("Avatar update returned no row");
                }
            } catch (dbError) {
                // The new file is unused now, so don't leave it behind.
                await deleteAvatar(newKey);
                throw dbError;
            }

            // Database now points at the new file: the old one can go.
            if (previousKey) {
                await deleteAvatar(previousKey);
            }

            return res.status(200).json({
                message: "Profile picture updated",
                profile: toResponse(profile),
            });
        } catch (error) {
            return handleError(res, error, "Upload avatar");
        }
    }
);

// Remove the profile picture. Safe to call when there is none.
router.delete("/profile/avatar", requireAuth, async (req, res) => {
    const userId = req.session.userId;

    if (userId === undefined) {
        return res.status(401).json({ message: "Not authenticated" });
    }

    try {
        const [existing] = await db
            .select(publicProfile)
            .from(profiles)
            .where(eq(profiles.userId, userId))
            .limit(1);

        if (!existing) {
            throw new HttpError(404, "Profile not found");
        }

        if (!existing.profilePictureKey) {
            return res.status(200).json({
                message: "No profile picture to remove",
                profile: toResponse(existing),
            });
        }

        // Database first, so the app never points at a file that is gone.
        const [profile] = await db
            .update(profiles)
            .set({ profilePictureKey: null, updatedAt: new Date() })
            .where(eq(profiles.userId, userId))
            .returning(publicProfile);

        if (!profile) {
            throw new HttpError(404, "Profile not found");
        }

        await deleteAvatar(existing.profilePictureKey);

        return res.status(200).json({
            message: "Profile picture removed",
            profile: toResponse(profile),
        });
    } catch (error) {
        return handleError(res, error, "Remove avatar");
    }
});

export default router;
```

### `backend/src/routes/users.ts` (step 4; an earlier version of the search was confirmed returning results, this profiles-based version is written, type-checked)

```typescript
import { Router } from "express";
import { and, asc, eq, like, ne, notExists, or, sql } from "drizzle-orm";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { db } from "../db/index.js";
import { blocks, profiles } from "../db/schema.js";
import { requireAuth } from "../middlewares/requireAuth.js";
import { handleError, validationError } from "../lib/http.js";

const router = Router();

const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL;

const SEARCH_LIMIT = 20;

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

// Lowercases and drops a leading "@" so "@Sam" finds "sam".
const searchQuerySchema = z.object({
    q: z
        .string()
        .trim()
        .toLowerCase()
        .max(100, "Search is too long")
        .transform((value) => value.replace(/^@/, ""))
        .pipe(z.string().min(1, "Enter a username to search")),
});

// A prefix of the username rule. A query that breaks it can never match a username.
const usernameQueryPattern = /^[a-z0-9_]{1,30}$/;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

// Columns that are safe to send to the client. No email, no bio: a private
// profile must not leak its bio through search. The username searched and
// returned is the profile's; users.username (the sign-up seed) never appears.
const searchResult = {
    username: profiles.username,
    profilePictureKey: profiles.profilePictureKey,
    visibility: profiles.visibility,
};

// "_" is a wildcard in LIKE and is allowed in usernames, so escape it
// (and "%" and "\" for safety) to get a true prefix match.
function escapeLike(value: string): string {
    return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

// Per user, not per IP. Typing fires several requests, so the limit is generous.
const searchLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 60,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => String(req.session.userId ?? "anonymous"),
    message: { message: "Too many searches. Try again in a minute." },
});

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

// Username prefix search. Public and private profiles both appear.
// Excluded: the viewer, and anyone blocked in either direction.
router.get("/users/search", requireAuth, searchLimiter, async (req, res) => {
    const viewerId = req.session.userId;

    if (viewerId === undefined) {
        return res.status(401).json({ message: "Not authenticated" });
    }

    const parsed = searchQuerySchema.safeParse(req.query);

    if (!parsed.success) {
        return validationError(res, parsed.error);
    }

    const query = parsed.data.q;

    if (!usernameQueryPattern.test(query)) {
        return res.status(200).json({ users: [] });
    }

    try {
        const rows = await db
            .select(searchResult)
            .from(profiles)
            .where(
                and(
                    like(profiles.username, `${escapeLike(query)}%`),
                    ne(profiles.userId, viewerId),
                    // A block in either direction hides the two users from each other.
                    notExists(
                        db
                            .select({ one: sql`1` })
                            .from(blocks)
                            .where(
                                or(
                                    and(
                                        eq(blocks.blockerId, viewerId),
                                        eq(blocks.blockedId, profiles.userId)
                                    ),
                                    and(
                                        eq(blocks.blockerId, profiles.userId),
                                        eq(blocks.blockedId, viewerId)
                                    )
                                )
                            )
                    )
                )
            )
            .orderBy(asc(profiles.username))
            .limit(SEARCH_LIMIT);

        return res.status(200).json({
            users: rows.map((row) => ({
                username: row.username,
                visibility: row.visibility,
                profilePictureUrl:
                    row.profilePictureKey && R2_PUBLIC_URL
                        ? `${R2_PUBLIC_URL}/${row.profilePictureKey}`
                        : null,
            })),
        });
    } catch (error) {
        return handleError(res, error, "Search users");
    }
});

export default router;
```

### Avatar upload and delete behavior (decided design)
- **Revised decision:** avatars are uploaded **through the backend**, not via presigned URLs. Reasons: strips EXIF/GPS metadata for privacy, validates by actually decoding the image (not trusting client content type), one request, no confirm endpoint, no orphaned "pending" uploads, no CORS needed for avatars. Presigned and multipart uploads remain the plan for **videos**.
- **Unique key per upload:** `avatars/{uuid}.webp` (no user id in the path; ownership comes from the `profiles` row). The CDN can cache files forever (`Cache-Control: public, max-age=31536000, immutable`) because a key never changes.
- **Processing:** `sharp` decodes (50M input pixel cap against decompression bombs), applies EXIF rotation, crops to a 512x512 square, encodes WebP quality 82. Limits: 5 MB, one file, 10 uploads per 10 minutes per user.
- **Replace order:** process, upload new object, read previous key, upsert DB, then best-effort delete the old object. If the DB write fails, the new object is deleted.
- **Remove order:** set `profilePictureKey` to null in the DB first, then best-effort delete the object. A failed R2 delete only leaves an unused file (logged), never a broken image.
- `deleteAvatar` refuses to delete any key not under `avatars/`.
- R2 SDK client is configured with `requestChecksumCalculation` and `responseChecksumValidation` set to `"WHEN_REQUIRED"` because R2 does not support the SDK's newer default checksums. This is already in `r2.ts`, so checksum behavior is not the cause of the current 403.

## 6. Frontend behavior

### Routing (`App.tsx`)
- Providers: `ThemeProvider` > `GoogleOAuthProvider` > `AuthProvider` > `BrowserRouter`.
- Public layout (with `Navbar`): `/`, `/sign-in`, `/sign-up`.
- Protected: `<Route element={<ProtectedRoute />}>` wrapping `<Route element={<SyncLayout />}>` with `/dashboard`, `/profile`, `/u/:username` and `/connect` (all future protected pages go here). Pages are loaded with `React.lazy`.
- `ProtectedRoute`: shows a loading state while `useAuth().loading`, redirects to `/sign-in` (with `state.from`) when there is no user, otherwise renders `<Outlet />`.
- `SyncLayout`: `SidebarProvider`, `AppSidebar`, `SidebarInset` with a header (`SidebarTrigger`, `ModeToggle`) and `<main className="flex flex-1 flex-col p-6">` around the `<Outlet />`.
- Sidebar nav (`app-sidebar.tsx`): Social = Home `/dashboard`, Chats `/chats` (badge), Friends `/friends`, Requests `/requests` (badge), Connect `/connect`; Account = Profile `/profile`, Settings `/settings`; Help `/help`. `/dashboard`, `/profile`, `/connect` and (by link or URL) `/u/:username` have pages so far. Sign out navigates to `/` first, then calls `signOut()`.

### Profile page (`Pages/profile.tsx`, rewritten 2026-11-09; type-checked against stubs, not yet confirmed running)
- Tailwind + shadcn (`Card`, `Avatar`, `Input`, `Textarea`, `Label`, `Button`), no CSS file, theme-token colors, works in dark and light.
- Profile data from `GET /api/profile` (`{ profile: { username, bio, profilePictureUrl, visibility } }`; fetch with `credentials: "include"`, base `VITE_API_URL ?? ""`). The username comes from the profile response (not `useAuth()`), so the view and the edit form agree.
- View mode: avatar (initials fallback from the username), `@username` as the page heading, bio (or an empty-state prompt), `VisibilityToggle`, "Edit profile".
- Edit mode: **username** (max 30, lowercased as you type, client check against `^[a-z0-9_]{3,30}$`, helper text that changing it breaks old links and is limited to 5 per hour) and **bio** (max 500), both with live counters. Sends `PUT /api/profile { bio, username? }`: the username is only included when it changed, so bio edits never count against the rename limit. Server errors (`{ message, errors: [{ field, message }] }`, including 409 "That username is taken") show under the inputs; other messages show above the buttons. Sending `""` for bio clears it.
- After a successful rename it calls `useAuth().refresh()` so the sidebar shows the new username without a reload.
- Avatar: hidden file input, "Add photo"/"Change photo" uploads immediately via `POST /api/profile/avatar` (multipart `FormData`, no manual Content-Type), local preview while uploading, "Remove" calls `DELETE /api/profile/avatar`. Client pre-checks type (image/*) and size (5 MB).
- Loading state uses `ProfileSkeleton`; 401 shows a session-expired message.

### User profile page (`Pages/user-profile.tsx`, route `/u/:username`; display name removed 2026-11-09, type-checked, not yet confirmed running)
- Fetches `GET /api/profile/:username` with the same `LoadState` + `useCallback` + `AbortController` pattern as the profile page; the loader depends on `username`, so moving between `/u/a` and `/u/b` shows the skeleton and refetches. States: loading (`UserProfileSkeleton`), unauthenticated, not-found (also shown for blocked users), error (with "Try again").
- `relationship === "self"` redirects to `/profile`.
- Header: avatar (initials from the username), `@username` as the heading, badges: "Private" (lock icon) for private profiles, plus a relationship badge: "Friends", "Friend request sent", "Sent you a friend request". Step 5 replaces the badges with real actions.
- Body is driven by `canViewFullProfile`, not by `visibility` alone (so a friend of a private profile still sees the bio). Non-friends of a private profile see: "This profile is private. You can see their bio once you’re friends." Public profiles with no bio show "No bio yet."
- Reached from the Connect results (each row links to `/u/:username`) or by URL.

### Connect page (`Pages/connect.tsx`, route `/connect`, step 4; search results confirmed rendering)
- Search box with a 300 ms debounce; the term is kept in the URL (`?q=`, `replace`) so Back restores the search; each new request aborts the previous one (`AbortController`); a leading `@` is ignored.
- Result rows: avatar (initials fallback from the username), `@username`, "Private" badge with a lock icon for private profiles; each row is a `Link` to `/u/:username`. No display name and no relationship in the list.
- States (`LoadState` union): idle prompt, skeleton (`UserListSkeleton`), results, empty ("No one matches ..."), error with "Try again", 401 session-expired message, 429 "too many searches" message.
- shadcn only: `Card`, `Input`, `Label` (sr-only), `Avatar`, `Badge`, `Button`, `Skeleton`.

### `VisibilityToggle` (`components/visibility-toggle.tsx`)
- Props: `value` (`"public" | "private"`) and `onSaved(value)`, called only after the server confirms. Default export.
- Saves immediately with `PUT /api/profile { visibility }`. The switch and text update right away (optimistic) and roll back with an error message if the request fails (401 gets a session-expired message).
- Heading, description and icon reflect the current state: private = lock, "Your profile is private", "People can find you in search, but only friends can see your bio."; public = globe, "Your profile is public", "Anyone can find you in search and see your bio." A small status line shows "Saving…" then "Saved".


### Loading skeletons (decision: use shadcn `Skeleton` throughout the app)
- Each page that fetches data gets its own skeleton file mirroring its layout (example: `profile-skeleton.tsx`); `PageSkeleton` is the generic fallback.
- Recommended wiring (instructions given, application not confirmed): lazy-load protected pages with `React.lazy`, wrap the `<Outlet />` in `SyncLayout` with `<Suspense fallback={<PageSkeleton />}>`, and use `PageSkeleton` inside `ProtectedRoute` while auth loads. Note `Suspense` only covers code loading; data fetched in `useEffect` still needs each page's own loading state.

## 7. Infrastructure: Cloudflare R2

- **Bucket name:** `earthsync` (permanent). Location: Automatic (Asia Pacific). Default storage class: Standard. Private by default; media is served via a custom domain, not `r2.dev`.
- **Domain:** `earthsync.space` is active on Cloudflare (free plan; nameservers changed at the registrar, which remains the registrar of record).
- **Custom domain for the bucket:** `cdn.earthsync.space` (Cloudflare adds CNAME `cdn` pointing to the bucket). The "Connect domain" step was started; confirm status is **Active** in bucket Settings > Custom Domains.
- **Public URL base:** `https://cdn.earthsync.space`; an avatar with key `avatars/<uuid>.webp` is served at `https://cdn.earthsync.space/avatars/<uuid>.webp`.
- Two separate addresses exist: the S3 API endpoint `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` (backend only, signed requests) and the public URL (`R2_PUBLIC_URL`, for browsers).
- **API token (as actually configured):** an **Account API token** (listed on the account-level token page, not the *User* API Tokens page, which is empty). Its policy covers the **entire account** (Workers, DNS, Billing, Zero Trust, Access and more, including Workers R2 Storage Read and Write). It is **not** scoped to the `earthsync` bucket as earlier docs said. It also has **Client IP Address Filtering** with a single allowed IP, the original network's address. Only the **Access Key ID** and **Secret Access Key** are used by the code. The separate "token value" Cloudflare shows (the user's `.env` has an empty `API_TOKEN=` line) is **not used** and can be removed.
- **Security note:** an account-wide token in `.env` is high risk if it ever leaks. Replace it with an R2-only token (see the fix plan below).

### Current problem: R2 returns 403 AccessDenied (open)

- **Symptoms:** `POST /api/profile/avatar` logs `Upload avatar error: AccessDenied` (HTTP 403), and removing the old object logs `R2 delete failed for avatars/<uuid>.webp: AccessDenied`. Uploads worked before the network switch (an avatar key was already stored).
- **Ruled out:** sessions/Postgres (separate service and credentials), changed `.env` values, SDK checksum settings (already `WHEN_REQUIRED`), missing permissions (Workers R2 Storage Read and Write are present).
- **Cause:** the token's IP allow-list. Requests from the hotspot come from a different IP and get rejected even though the keys are valid.
- **Update 2026-11-09:** the hotspot IP (IPv4 and an IPv6 address) was added to the allow-list and the 403 returned. A phone hotspot's public IP changes whenever the carrier reassigns it and Node may connect over a different address than the browser reports, so an IP allow-list will keep breaking on this connection. Advice given: remove both IP entries (an empty list means any address) for development, and create the R2-only token. Outcome not yet confirmed.
- **Fix plan (not yet applied):**
  1. Quick: edit the token and remove the IP filter (or add the current IP; hotspot IPs change often). Editing the filter does not change the keys, so no restart is needed unless `.env` changes.
  2. Better: create a new R2-only token (R2 > Manage API tokens > Object Read & Write, limited to `earthsync`), no IP filter while developing (add the production server's static IP later), put the new Access Key ID and Secret Access Key in `.env`, restart the server, then delete the old account-wide token.
  3. Retest upload, replace and remove end to end.
- If the 403 persists once the filter is gone: check the bucket name, the endpoint (`https://<ACCOUNT_ID>.r2.cloudflarestorage.com`, no bucket in the URL; EU-jurisdiction buckets use `.eu.r2.cloudflarestorage.com`) and that the key pair is the S3-compatible pair, not the Cloudflare token value.

### Bucket CORS (only needed for future direct browser-to-R2 uploads, i.e. video; harmless to add now)

```json
[
  {
    "AllowedOrigins": ["http://localhost:5173", "https://earthsync.space"],
    "AllowedMethods": ["GET", "PUT", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

### Object key layout
- `avatars/{uuid}.webp` (implemented)
- Planned for later: `images/{userId}/{uuid}.jpg`, `videos/{userId}/{uuid}.mp4`, `raw/videos/{userId}/{uuid}` (unprocessed uploads awaiting ffmpeg; add an R2 lifecycle rule to auto-delete `raw/` after 1-2 days).

## 8. Environment variables

No real values have been shared. Fill values locally; keep `.env` out of git.

### Backend `.env`

```
SESSION_SECRET=<long random string>
NODE_ENV=development            # "production" in prod
CLIENT_ORIGIN=http://localhost:5173   # production: https://earthsync.space
GOOGLE_CLIENT_ID=<from Google Cloud Console>
DATABASE_URL=<Neon pooled connection string>   # read by db/index.ts and lib/session.ts (both throw/fail without it)

R2_PUBLIC_URL=https://cdn.earthsync.space
R2_ACCOUNT_ID=<Cloudflare account id>
R2_ACCESS_KEY_ID=<from R2 API token>
R2_SECRET_ACCESS_KEY=<from R2 API token, shown only once>
R2_BUCKET=earthsync
```

(The R2 variable names were added to the backend `.env` by the user; values are held locally.)

### Frontend `.env`

```
VITE_GOOGLE_CLIENT_ID=<same Google client id>
VITE_API_URL=<backend base URL, e.g. http://localhost:3000; empty if using a Vite proxy>
```

### URLs
- Dev frontend `http://localhost:5173`; production frontend `https://earthsync.space` (API could be `api.earthsync.space`; still works with `sameSite: "lax"` since both are the same site).
- Frontend calls `/api/auth/...`, `/api/profile...` with `credentials: "include"`.
- Google Sign-In: the frontend sends the Google ID token as `credential` to `POST /api/auth/google`.

## 9. Neon-specific notes

- Use the **pooled** connection string (host contains `-pooler`) for the API.
- Use the **direct (unpooled)** connection string for migrations and any job queue (e.g. `pg-boss`).
- Free tier scales compute to zero when idle, so the first query after quiet time can be slow. The session store prunes only hourly for this reason.
- **Port 5432 can be blocked by the network.** Plain-TCP Postgres clients then fail with `connect ETIMEDOUT ...:5432`. In this project that affects the session store's `pg.Pool` (`lib/session.ts`) and `drizzle-kit migrate/push/studio` (they use the `pg` driver). Quick check: `Test-NetConnection <real-neon-host> -Port 5432` (use the real host from `DATABASE_URL`, not a placeholder). The fix used was switching to a phone hotspot.
- If stuck on a network that blocks 5432: either run the session store over Neon's WebSocket `Pool` (`import { Pool, neonConfig } from "@neondatabase/serverless"`, `neonConfig.webSocketConstructor = ws`, port 443; `connect-pg-simple` accepts it), or paste migration SQL into Neon's SQL Editor (note the Drizzle journal then won't record it and a later `migrate` may fail with "already exists").
- **Hotspot quirks:** a one-off `getaddrinfo ENOTFOUND` for the Neon host was a transient DNS failure (confirm with `nslookup <host>`; `ipconfig /flushdns` or DNS `1.1.1.1` if it persists). If connects time out intermittently while DNS resolves, prefer IPv4: `$env:NODE_OPTIONS="--dns-result-order=ipv4first"`.
- **SSL warning** from `pg-connection-string` about `sslmode=require` is harmless today. To silence it and keep current behavior, use `sslmode=verify-full`; for libpq semantics use `uselibpqcompat=true&sslmode=require`.

## 10. Planned: chat MVP (not built)

### Scope
1. **Find people:** search by username (prefix match), returning only safe fields (username, visibility, avatar URL; never email or bio). Both public and private profiles appear (a private profile shows only its header to non-friends), and users blocked in either direction are excluded. Send, accept, decline, cancel friend requests; friends list. "Matching" is skipped for the MVP. Maps to the sidebar pages Connect, Requests, Friends, Chats.
2. **WebSocket chat (1:1):** the socket is only the delivery pipe; messages are **persisted in Neon**. Send over the socket, server validates and saves, then pushes to the recipient's open sockets. History loads over a paginated REST endpoint.

### Data model (friend graph is in the schema; messages are not)
- `profiles.visibility`: `public` or `private`. Both are searchable. Anyone not blocked can view a public profile and send a request; a private profile shows only its header to non-friends (friends and the owner see everything). Private users can still send requests and chat with friends.
- `friend_requests`: pending only, row deleted when resolved. Incoming = `receiver_id` is me, outgoing = `sender_id` is me. Accept = delete the row and insert a friendship in one transaction (neon-serverless supports transactions); decline/cancel = delete the row. One pending request per pair in either direction.
- `friendships`: one row per pair, `userLowId < userHighId`, unique pair index.
- `blocks`: directional; either direction hides both users; blocking deletes the friendship and pending requests in one transaction.
- `messages` (**not built**): friendship id, sender id, body, created at; index for "latest messages in this chat". Messages hang off `friendships.id` (1:1 only); introduce a `conversations` table if group chats are added.

### Non-friend messaging rule (decided; design open)
- A non-friend can send **one message** to another user until both are friends (a request is accepted). Later, posts and feeds are hidden from non-friends using the same `canViewFullProfile` check.
- Problem: messages are planned to hang off `friendships.id`, and non-friends have no friendship row. Choose before the chat schema: a `conversations` table (also helps with groups later), or messages keyed by a sender/receiver pair with a nullable friendship id.
- Open questions: is the limit one message per sender-to-receiver pair, what happens to that message if the request is declined, cancelled or the user is blocked, and how it interacts with rate limits and the recipient's inbox (a "message request" view).

### "Isolated pipe" requirements
- Authenticate the socket with the existing session cookie during the HTTP upgrade handshake and check the `Origin` header; the session config is now shared: `sessionMiddleware` and `sessionStore` are exported from `lib/session.ts` for the WebSocket upgrade handler to reuse.
- The server decides sender identity (never the client) and checks on every message that sender and recipient are accepted friends.
- Cap message size, rate-limit per connection, use ping/pong heartbeats.
- Single server instance for now (in-memory socket tracking); multiple instances would need pub/sub (Redis or Postgres notifications).
- Blocking: the `blocks` table exists. The block checks in search (`GET /api/users/search`) and profile view (`GET /api/profile/:username`) are done (search exclusion has not been exercised with real `blocks` rows yet); the block/unblock routes and the checks in friend requests and message send are pending and should be in place before any public launch.

### Suggested build order
Schema + migration, then search and friend-request routes with UI, then message history REST, then the WebSocket server, then the chat UI. The session store is already replaced (section 12). Agreed order for the friend graph, each backend piece followed by its UI: (3) visibility + viewing others [done], (4) user search [done], (5) friend requests, (6) block/unblock. Then decide the non-friend message design above, then the chat schema, history REST, WebSocket server and chat UI.

## 11. Code conventions (match these when adding code)

### Backend
- TypeScript ESM, **4-space indent**, semicolons, relative imports end with `.js`.
- One router file per area; routes declare their full path (e.g. `/auth/sign-in`, `/profile`); routers are mounted at `/api` in `app.ts`.
- Section comment banners: `/* ---- */` blocks with titles (Validation, Helpers, Routes).
- zod schemas at the top of the router file, `safeParse`, early return via `validationError(res, parsed.error)`.
- Routes needing a logged-in user use `requireAuth` and read `req.session.userId`.
- Errors: throw `HttpError(status, message)` from helpers; wrap handlers in try/catch and `return handleError(res, error, "Label")`.
- Select only safe columns with a named column object (like `publicUser`, `publicProfile`); never send `passwordHash`.
- Early-return style; comments explain *why*. Drizzle with the shared `db`; the neon-serverless driver supports transactions.

### Frontend
- **2-space indent, no semicolons, double quotes**, `@/` import alias.
- Tailwind classes with shadcn theme tokens (never hard-coded colors); shadcn components for UI.
- Pages are default exports in `src/Pages`; protected pages are registered under `ProtectedRoute` > `SyncLayout` in `App.tsx`.
- Page layout is supplied by `SyncLayout` (`<main className="p-6">`): pages must not set their own full-screen height or background.
- Every data-fetching page gets a matching skeleton component (named export, `role="status"`, mirrors the page layout); fetches use `credentials: "include"` and handle 401.
- Data-fetching pages use a `LoadState` union, a `useCallback` loader and an `AbortController` (see `Pages/profile.tsx`). JSX text uses typographic apostrophes (’); error strings read "Could not …".
- Copy style: sentence case, active voice, specific button labels ("Save changes"), errors say what went wrong and how to fix it.

## 12. Known issues / things to fix

1. **Session store (resolved):** replaced the in-memory store with `connect-pg-simple` on Neon (`lib/session.ts`). Residual: it needs port 5432 reachable (see section 9), and survival across a server restart has not been explicitly tested.
2. No `build`/`start` scripts yet (e.g. `tsc` then `node dist/server.js`).
3. `profiles.updatedAt` uses Drizzle's `$onUpdate` (only applied by Drizzle `.update()` calls); the upserts set `updatedAt` explicitly.
4. Deleting a user does not delete their R2 objects.
5. **Open frontend issue:** the console warning `No routes matched location "/profile"` was reported. The pasted `App.tsx` does define the route correctly; suspected causes were a stale HMR/console message, a different `App` being rendered from `main.tsx`, or a second router wrapping the app. Resolution not confirmed.
6. **One-message rule for non-friends:** design not decided (section 10); it affects the chat schema, not steps 3 to 6.
7. **R2 403 AccessDenied (open):** caused by the token's IP allow-list; fix plan in section 7.
8. **Over-broad R2 credentials:** the R2 token is an account-wide Account API token. Replace with an R2-only token scoped to `earthsync`.
9. **Port 5432 dependency:** sessions and `drizzle-kit` need outbound 5432. On a blocking network use a hotspot or the Neon WebSocket pool (section 9).
10. **Migrations 0003 and 0004 (resolved):** both applied; all tables exist and `profiles.username` is verified (section 4).
11. **(resolved)** The `profileVisibility` comment in `schema.ts` now states the rule that private profiles are searchable.
12. **`users.username` is a seed only.** Not unique, never displayed, searched or used for sign-in. It could be removed later by writing the sign-up value straight into `profiles`.
13. **Old Google accounts were renamed by the backfill.** Accounts without a password got random `user_xxxxxxxx` names in migration 0004 (test accounts `solo`, `solomusic` and `kirondeep` among them). Rename from the profile page, or for test accounts only: `update profiles set username = '<name>' where user_id = <id>;`.
14. **`profiles.display_name` is unused.** Drop it in a later migration (remove from `schema.ts`, generate, migrate).
15. **Renaming breaks old `/u/<name>` links** and a released name can be taken by someone else immediately. Consider reserving old names or keeping a rename history later.
16. **Search index:** a plain btree index may not serve `LIKE 'abc%'` unless the database uses the C collation. Fine at current size; if search gets slow add a custom migration: `CREATE INDEX profiles_username_prefix_idx ON profiles (username varchar_pattern_ops);`.
17. **`AuthProvider.refresh()` sets `user` to null on any failure**, including a network blip, so a failed refresh after a rename would look like a sign-out. Consider keeping the previous user on non-401 errors.
18. **Console noise that is harmless:** Grammarly and other extension errors, `[GSI_LOGGER] google.accounts.id.initialize() is called multiple times` (Google Sign-In mounted twice in dev) and `Cross-Origin-Opener-Policy ... postMessage` (Google popup). Test API calls from the console against the backend URL, not a relative `/api` path.

## 13. Pending / next steps

### Open
- [ ] **Fix R2 403:** remove or update the token's IP filter, or (preferred) create a new R2-only token (Object Read & Write on `earthsync`, no IP filter for dev); update `.env` if keys change; restart; then test avatar upload, replace and remove end to end
- [ ] Confirm sessions persist across a server restart (migrations 0003 and 0004 are applied)
- [ ] Make sure `npx shadcn@latest add switch badge` was run, and that lazy pages (including `/u/:username` and `/connect`) have a `Suspense` fallback
- [ ] **Test the new profile edit end to end:** rename (free name works, `kirondeep1`-style taken name gives 409, 6th change in an hour is limited), the sidebar updates without a reload, bio edit, avatar upload (needs the R2 fix)
- [ ] **Test the private-profile view from a second account:** private shows header and the private message with no bio, public shows the bio, `/u/<own username>` redirects to `/profile`, `/u/nobody_here` shows not found, a friend of a private profile sees the bio (after step 5)
- [ ] Test block exclusion in search once `blocks` rows exist (step 6)
- [ ] Cleanup: drop `profiles.display_name`; optionally drop `users.username` later; optionally add a "copy your @username" button on the profile page
- [ ] Optional: make `AuthProvider.refresh()` keep the previous user on non-401 errors; add a Vite `/api` proxy so relative URLs work in the console
- [ ] **Step 5: friend requests.** Backend: send, cancel, decline, accept (delete request + insert friendship in one transaction, smaller id first), incoming and outgoing lists, friends list. Then UI: action buttons on `/u/:username` (replacing the relationship badges), Requests and Friends pages, sidebar badges
- [ ] **Step 6: block/unblock.** Backend: block (delete friendship and pending requests in one transaction) and unblock, blocked list. Then UI: block/unblock on `/u/:username`, blocked users list in Settings
- [ ] Decide the non-friend one-message design (section 10) before writing the chat schema
- [ ] Chat MVP: `messages` schema, message history REST, WebSocket server (reuse `sessionMiddleware`), chat UI
- [ ] Confirm `cdn.earthsync.space` is **Active**; optionally add the bucket CORS policy
- [ ] Remove the unused `API_TOKEN` line from `.env`
- [ ] Resolve the `No routes matched "/profile"` warning (may already be gone; recheck)
- [ ] Optional: switch the session store to Neon's WebSocket pool if the 5432 block returns; set `sslmode=verify-full` to silence the `pg` warning
- [ ] Later: image/video posts with the `media` table (presigned + multipart for video), ffprobe duration limit, ffmpeg worker; hide posts and feeds from non-friends
- [ ] Add `build`/`start` scripts
- [ ] Optional later: Spotify connection (own tables), profile prompts, favorite artists, report flow

### Done
- [x] **Step 4:** user search. Backend (`routes/users.ts`, `GET /api/users/search`) and frontend (`/connect` page, `UserListSkeleton`). Results confirmed rendering
- [x] **Username redesign:** `profiles.username` is the single public, unique username; display name removed from the UI and API; profile created at sign-up in one transaction; Google sign-up gets a random username; sign-in matches profile username or email; rename via `PUT /api/profile` (409 on taken, 5 per hour); email never exposed outside `/auth/me`
- [x] Migration 0004 (hand-written backfill SQL) applied and verified in Neon; migration 0003 confirmed applied
- [x] Profile page edits username and bio and refreshes the sidebar after a rename; user-profile page header shows `@username`
- [x] Schema comment on `profileVisibility` rewritten
- [x] **Step 3:** profile visibility and viewing others. Backend (`visibility` in `/api/profile`, `GET /api/profile/:username`, `lib/relationships.ts`) and frontend (`/u/:username` page, `VisibilityToggle`, skeleton, profile page and `App.tsx` wiring). Toggle redesigned to show the current state
- [x] Decision: private profiles are searchable; one message for non-friends until mutual friends; posts and feeds hidden from non-friends later
- [x] Replace the in-memory session store with `connect-pg-simple` (`lib/session.ts`, `app.ts` uses `sessionMiddleware`); working once the network allowed port 5432
- [x] Install backend packages and apply `lib/http.ts`, `auth.ts` imports, `lib/r2.ts`, `routes/profile.ts` and the `app.ts` mounting; fill R2 env values (the server runs and reaches R2)
- [x] Define schema for visibility, friend requests, friendships, blocks and sessions; `drizzle-kit generate` succeeded (migration 0003)
- [x] Diagnose the `ETIMEDOUT` (blocked port 5432) and the R2 `AccessDenied` (token IP allow-list)