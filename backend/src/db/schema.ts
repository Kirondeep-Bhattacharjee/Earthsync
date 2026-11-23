import {
    pgTable,
    pgEnum,
    serial,
    integer,
    smallint,
    bigint,
    uuid,
    varchar,
    text,
    boolean,
    json,
    timestamp,
    date,
    index,
    uniqueIndex,
    primaryKey,
    check,
    type AnyPgColumn
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
// Visibility only controls what non-friends can see on the profile; it does not
// affect who can message you (chat is open to anyone who is not blocked).
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
/* Account private data (never returned by any API)                    */
/* ------------------------------------------------------------------ */

// A row here means the user has finished onboarding (date of birth given).
// Accounts that existed before this table have no row, which is how the
// onboarding gate finds them. Always select explicit columns from this table;
// never join it into an object that is sent to a client.
export const accountPrivate = pgTable(
    "account_private",
    {
        userId: integer("user_id")
            .primaryKey()
            .references(() => users.id, { onDelete: "cascade" }),
        dateOfBirth: date("date_of_birth", { mode: "string" }).notNull(), // "YYYY-MM-DD"
        createdAt: timestamp("created_at").defaultNow().notNull(),
    },
    (t) => [index("account_private_dob_idx").on(t.dateOfBirth)]
)

/* ------------------------------------------------------------------ */
/* Consents (record of what was accepted, and which version)           */
/* ------------------------------------------------------------------ */

// One kind per checkbox on the onboarding form:
//   age_confirmation  "I confirm I'm 18 or older"
//   terms_privacy     "I agree to the Terms of Service and Privacy Policy"
// Current versions live in lib/consent.ts. Bumping a version there is what
// sends everyone back through onboarding.
export const consentKind = pgEnum("consent_kind", [
    "age_confirmation",
    "terms_privacy",
])

export const consents = pgTable(
    "consents",
    {
        id: serial("id").primaryKey(),
        userId: integer("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        kind: consentKind("kind").notNull(),
        version: varchar("version", { length: 20 }).notNull(), // e.g. "2026-11-19"
        acceptedAt: timestamp("accepted_at").defaultNow().notNull(),
    },
    (t) => [
        // One acceptance per user per kind per version.
        uniqueIndex("consents_user_kind_version_idx").on(
            t.userId,
            t.kind,
            t.version
        ),
    ]
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
// so a pair can never be friends twice. Friendship only gates profile content;
// messages live in conversations.
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
/* Conversations (one row per pair of users, ids stored in order)      */
/* ------------------------------------------------------------------ */

// A conversation is a thread between two users. It is created in the same
// transaction as the first message between them. Friendship is NOT required and
// is never stored here: unfriending leaves the thread alone, and the inbox
// works out "Friends" vs "Public" at read time by looking for a friendships row.
// Blocking locks the thread (checked in sendMessage), it does not delete it.
//
// The app must always store the smaller user id in userLowId (same rule as
// friendships).
//
// Delete chat = hide for one person only: set that person's *HiddenBefore to now.
// Messages with created_at <= that timestamp are not shown to them; no rows are
// deleted, and a new message after it makes the thread visible again.
export const conversations = pgTable(
    "conversations",
    {
        id: serial("id").primaryKey(),
        userLowId: integer("user_low_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        userHighId: integer("user_high_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        lowHiddenBefore: timestamp("low_hidden_before"),
        highHiddenBefore: timestamp("high_hidden_before"),
        // Denormalized so the inbox can sort without scanning messages. Update it
        // in the same transaction that inserts a message.
        lastMessageAt: timestamp("last_message_at").defaultNow().notNull(),
        createdAt: timestamp("created_at").defaultNow().notNull(),
        lowReadAt: timestamp("low_read_at"),
        highReadAt: timestamp("high_read_at"),
        // Set by a report so the retention job keeps this thread as evidence.
        retentionHold: boolean("retention_hold").notNull().default(false),
    },
    (t) => [
        check("conversations_ordered", sql`${t.userLowId} < ${t.userHighId}`),
        // One thread per pair; also the lookup when sending a message.
        uniqueIndex("conversations_pair_idx").on(t.userLowId, t.userHighId),
        // Inbox: "my conversations, newest first", from either side of the pair.
        index("conversations_low_last_idx").on(t.userLowId, t.lastMessageAt),
        index("conversations_high_last_idx").on(t.userHighId, t.lastMessageAt),
    ]
)

/* ------------------------------------------------------------------ */
/* Messages                                                            */
/* ------------------------------------------------------------------ */

export const messageKind = pgEnum("message_kind", ["text", "image", "voice"])

// Messages belong to a conversation, never to a friendship. senderId must be
// one of the conversation's two users: a check constraint can't see another
// table, so sendMessage() enforces it (the sender comes from the session, never
// from the client). Pagination cursor is the id (it only grows), so history
// loads as "id < cursor, newest first".
//
// Text is stored encrypted (body_enc + key_version). `body` is the old
// plaintext column: nullable now, and dropped once the backfill has run.
// Image and voice messages carry a media row instead of text.
export const messages = pgTable(
    "messages",
    {
        id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
        conversationId: integer("conversation_id")
            .notNull()
            .references(() => conversations.id, { onDelete: "cascade" }),
        senderId: integer("sender_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        kind: messageKind("kind").notNull().default("text"),
        body: varchar("body", { length: 2000 }),
        bodyEnc: text("body_enc"),
        keyVersion: smallint("key_version"),
        // The retention job deletes the message first, then its media row.
        mediaId: uuid("media_id")
        .unique()
        .references(() => media.id),
        createdAt: timestamp("created_at").defaultNow().notNull(),
    },
    (t) => [
        // Text needs a body (plain or encrypted); image and voice need media.
        check(
            "messages_content",
            sql`(${t.kind} = 'text' AND (${t.body} IS NOT NULL OR ${t.bodyEnc} IS NOT NULL)) OR (${t.kind} <> 'text' AND ${t.mediaId} IS NOT NULL)`
        ),
        // An encrypted body always says which key encrypted it.
        check(
            "messages_enc_has_version",
            sql`${t.bodyEnc} IS NULL OR ${t.keyVersion} IS NOT NULL`
        ),
        // "Latest messages in this conversation" and the id cursor.
        index("messages_conversation_idx").on(t.conversationId, t.id.desc()),
    ]
)

/* ------------------------------------------------------------------ */
/* Media (images and videos stored in R2) - not used by avatars        */
/* ------------------------------------------------------------------ */

export const mediaType = pgEnum("media_type", ["image", "video", "audio"])
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
        thumbKey: varchar("thumb_key", { length: 255 }), // thumbnail object key
        type: mediaType("type").notNull(),
        contentType: varchar("content_type", { length: 100 }).notNull(),
        sizeBytes: bigint("size_bytes", { mode: "number" }),
        width: integer("width"),
        height: integer("height"),
        durationSeconds: integer("duration_seconds"), // videos only
        status: mediaStatus("status").notNull().default("pending"),
        // SHA-256 of the stored bytes: proves later that evidence is unchanged.
        sha256: varchar("sha256", { length: 64 }),
        createdAt: timestamp("created_at").defaultNow().notNull(),
    },
    (t) => [index("media_user_id_idx").on(t.userId)]
)


/* ------------------------------------------------------------------ */
/* Posts (one photo or video plus a caption, shown on the profile)     */
/* ------------------------------------------------------------------ */

// Visibility follows the author's profile rule (public: anyone not blocked,
// private: friends and the owner), checked on every read, so it is not stored here.
export const posts = pgTable(
    "posts",
    {
        id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
        authorId: integer("author_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        mediaId: uuid("media_id")
            .notNull()
            .unique()
            .references(() => media.id, { onDelete: "cascade" }),
        caption: varchar("caption", { length: 500 }),
        createdAt: timestamp("created_at").defaultNow().notNull(),
    },
    (t) => [
        // The profile grid: "this author's posts, newest first" with an id cursor.
        index("posts_author_idx").on(t.authorId, t.id.desc()),
    ]
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

export const postLikes = pgTable(
    "post_likes",
    {
        postId: bigint("post_id", { mode: "number" })
            .notNull()
            .references(() => posts.id, { onDelete: "cascade" }),
        userId: integer("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        createdAt: timestamp("created_at").defaultNow().notNull(),
    },
    (t) => [
        primaryKey({ columns: [t.postId, t.userId] }),
        // The primary key covers "likes on this post"; this covers user deletes
        // and a future "posts I liked".
        index("post_likes_user_idx").on(t.userId),
    ]
)


export const postComments = pgTable(
    "post_comments",
    {
        id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
        postId: bigint("post_id", { mode: "number" })
            .notNull()
            .references(() => posts.id, { onDelete: "cascade" }),
        authorId: integer("author_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        parentId: bigint("parent_id", { mode: "number" }).references(
            (): AnyPgColumn => postComments.id,
            { onDelete: "cascade" }
        ),
        body: varchar("body", { length: 500 }).notNull(),
        createdAt: timestamp("created_at").defaultNow().notNull(),
    },
    (t) => [
        check("post_comments_body_not_empty", sql`length(btrim(${t.body})) > 0`),
        // Top-level list: "this post's comments, newest first" with an id cursor.
        index("post_comments_post_idx").on(t.postId, t.id.desc()),
        // Replies of one comment, oldest first.
        index("post_comments_parent_idx").on(t.parentId, t.id),
        index("post_comments_author_idx").on(t.authorId),
    ]
)