import { Router } from "express";
import { and, desc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { db } from "../db/index.js";
import {
    blocks,
    conversations,
    friendships,
    messages,
    profiles,
} from "../db/schema.js";
import { requireAuth } from "../middlewares/requireAuth.js";
import { handleError, validationError } from "../lib/http.js";
import {
    chatMessageFromSent,
    findPeer,
    messageBodySchema,
    previewText,
    readMessageText,
    sendMessage,
    serializeMessage,
} from "../lib/chat.js";
import { announceMessage } from "../lib/socket.js";
import { usernameSchema } from "../lib/username.js";

const router = Router();

const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL;

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

const sendSchema = z.object({
    username: usernameSchema,
    body: messageBodySchema,
});

// box = which inbox tab: friends, or public (people you are not friends with).
// Omitted = both.
const inboxQuerySchema = z.object({
    box: z.enum(["friends", "public"]).optional(),
});

// before = the id of the oldest message the client already has; the page
// returned is the messages older than that.
const historyQuerySchema = z.object({
    before: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().min(1).max(50).default(30),
});

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function pictureUrl(key: string | null): string | null {
    return key && R2_PUBLIC_URL ? `${R2_PUBLIC_URL}/${key}` : null;
}

// SQL pieces shared by the inbox and the unread count, so both always agree on
// which threads exist for me and which of them are unread.
function inboxFilters(viewerId: number) {
    // The other person in each row, whichever side of the pair I am on.
    const otherId = sql<number>`case when ${conversations.userLowId} = ${viewerId} then ${conversations.userHighId} else ${conversations.userLowId} end`;

    // Same pair ordering as friendships (smaller id first), so the pair
    // matches directly.
    const friendExists = sql`exists (select 1 from ${friendships} where ${friendships.userLowId} = ${conversations.userLowId} and ${friendships.userHighId} = ${conversations.userHighId})`;

    const blockedEitherWay = sql`exists (select 1 from ${blocks} where (${blocks.blockerId} = ${viewerId} and ${blocks.blockedId} = ${otherId}) or (${blocks.blockerId} = ${otherId} and ${blocks.blockedId} = ${viewerId}))`;

    const visibleToMe = or(
        and(
            eq(conversations.userLowId, viewerId),
            or(
                isNull(conversations.lowHiddenBefore),
                gt(conversations.lastMessageAt, conversations.lowHiddenBefore)
            )
        ),
        and(
            eq(conversations.userHighId, viewerId),
            or(
                isNull(conversations.highHiddenBefore),
                gt(conversations.lastMessageAt, conversations.highHiddenBefore)
            )
        )
    );

    const myReadAt = sql`case when ${conversations.userLowId} = ${viewerId} then ${conversations.lowReadAt} else ${conversations.highReadAt} end`;
    const myHiddenBefore = sql`case when ${conversations.userLowId} = ${viewerId} then ${conversations.lowHiddenBefore} else ${conversations.highHiddenBefore} end`;

    // Unread = the other person sent a message that is newer than my read
    // marker (and newer than anything I deleted). My own messages never count.
    // All comparisons run in SQL so clocks cannot disagree.
    const hasUnread = sql<boolean>`exists (select 1 from ${messages} where ${messages.conversationId} = ${conversations.id} and ${messages.senderId} <> ${viewerId} and (${myReadAt} is null or ${messages.createdAt} > ${myReadAt}) and (${myHiddenBefore} is null or ${messages.createdAt} > ${myHiddenBefore}))`;

    return { friendExists, blockedEitherWay, visibleToMe, hasUnread, otherId };
}

// Typing is not free: someone could flood a thread. Per user, not per thread.
const sendLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 60,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => String(req.session.userId ?? "anonymous"),
    message: { message: "You are sending messages too fast. Slow down." },
});

/* ------------------------------------------------------------------ */
/* Send                                                                */
/* ------------------------------------------------------------------ */

// Send a message to a username. The thread is created on the first message.
// Friendship is not required; blocked or unknown usernames are a 404.
router.post("/messages", requireAuth, sendLimiter, async (req, res) => {
    const viewerId = req.session.userId;

    if (viewerId === undefined) {
        return res.status(401).json({ message: "Not authenticated" });
    }

    const parsed = sendSchema.safeParse(req.body);

    if (!parsed.success) {
        return validationError(res, parsed.error);
    }

    try {
        const peerId = await findPeer(viewerId, parsed.data.username);
        const sent = await sendMessage(viewerId, peerId, parsed.data.body);

        // Deliver live to every open tab of both people (never throws).
        await announceMessage(sent);

        return res.status(201).json({
            chatMessage: chatMessageFromSent(sent, true),
        });
    } catch (error) {
        return handleError(res, error, "Send message");
    }
});

/* ------------------------------------------------------------------ */
/* Inbox                                                               */
/* ------------------------------------------------------------------ */

// My conversations, newest first, with the last message, whether the other
// person is a friend right now, and whether the thread has unread messages.
// "Friends" vs "Public" is worked out here at read time from the friendships
// table, never stored, so unfriending moves a thread to the Public tab without
// touching the conversation.
//
// Hidden for me (I deleted the chat and nothing new has arrived) are left out.
// Threads with someone blocked in either direction are left out too, so a block
// never reveals anything; what a blocked person still sees is a step 6 decision.
// Not paginated: capped at 100.
router.get("/conversations", requireAuth, async (req, res) => {
    const viewerId = req.session.userId;

    if (viewerId === undefined) {
        return res.status(401).json({ message: "Not authenticated" });
    }

    const parsed = inboxQuerySchema.safeParse(req.query);

    if (!parsed.success) {
        return validationError(res, parsed.error);
    }

    try {
        const { friendExists, blockedEitherWay, visibleToMe, hasUnread, otherId } =
            inboxFilters(viewerId);

        const boxFilter =
            parsed.data.box === "friends"
                ? friendExists
                : parsed.data.box === "public"
                  ? sql`not ${friendExists}`
                  : undefined;

        const rows = await db
            .select({
                conversationId: conversations.id,
                lastMessageAt: conversations.lastMessageAt,
                username: profiles.username,
                visibility: profiles.visibility,
                profilePictureKey: profiles.profilePictureKey,
                isFriend: sql<boolean>`${friendExists}`,
                unread: hasUnread,
            })
            .from(conversations)
            .innerJoin(profiles, eq(profiles.userId, otherId))
            .where(and(visibleToMe, sql`not ${blockedEitherWay}`, boxFilter))
            .orderBy(desc(conversations.lastMessageAt))
            .limit(100);

        if (rows.length === 0) {
            return res.json({ conversations: [] });
        }

        // Last message of each thread, in one query. A thread that is visible to
        // me has its last message newer than my hidden-before, so it is safe to show.
        const lastRows = await db
            .select({
                id: messages.id,
                conversationId: messages.conversationId,
                senderId: messages.senderId,
                kind: messages.kind,
                body: messages.body,
                bodyEnc: messages.bodyEnc,
                keyVersion: messages.keyVersion,
                createdAt: messages.createdAt,
            })
            .from(messages)
            .where(
                inArray(
                    messages.id,
                    db
                        .select({ id: sql<number>`max(${messages.id})` })
                        .from(messages)
                        .where(
                            inArray(
                                messages.conversationId,
                                rows.map((row) => row.conversationId)
                            )
                        )
                        .groupBy(messages.conversationId)
                )
            );

        const lastByConversation = new Map(
            lastRows.map((row) => [row.conversationId, row])
        );

        return res.json({
            conversations: rows.map((row) => {
                const last = lastByConversation.get(row.conversationId);

                return {
                    username: row.username,
                    visibility: row.visibility,
                    profilePictureUrl: pictureUrl(row.profilePictureKey),
                    isFriend: row.isFriend,
                    unread: row.unread,
                    lastMessageAt: row.lastMessageAt,
                    lastMessage: last
                        ? {
                              kind: last.kind,
                              // Text, or "Photo" / "Voice message".
                              body: previewText(last.kind, readMessageText(last)),
                              fromMe: last.senderId === viewerId,
                              createdAt: last.createdAt,
                          }
                        : null,
                };
            }),
        });
    } catch (error) {
        return handleError(res, error, "List conversations");
    }
});

// Number of threads with unread messages, split by tab. The sidebar badge
// shows `friends` only: messages from people who are not friends stay quiet
// there and are highlighted in the Public tab instead.
router.get("/conversations/unread-count", requireAuth, async (req, res) => {
    const viewerId = req.session.userId;

    if (viewerId === undefined) {
        return res.status(401).json({ message: "Not authenticated" });
    }

    try {
        const { friendExists, blockedEitherWay, visibleToMe, hasUnread } =
            inboxFilters(viewerId);

        const rows = await db
            .select({ isFriend: sql<boolean>`${friendExists}` })
            .from(conversations)
            .where(and(visibleToMe, sql`not ${blockedEitherWay}`, hasUnread));

        const friends = rows.filter((row) => row.isFriend).length;

        return res.json({ friends, public: rows.length - friends });
    } catch (error) {
        return handleError(res, error, "Unread count");
    }
});

/* ------------------------------------------------------------------ */
/* History                                                             */
/* ------------------------------------------------------------------ */

// One page of a thread, newest page first. Inside a page the messages are in
// reading order (oldest to newest). `nextCursor` is the id to pass as `before`
// for the next older page, or null when there is nothing older. No thread yet
// is an empty page, not an error.
router.get(
    "/conversations/:username/messages",
    requireAuth,
    async (req, res) => {
        const viewerId = req.session.userId;

        if (viewerId === undefined) {
            return res.status(401).json({ message: "Not authenticated" });
        }

        const parsed = historyQuerySchema.safeParse(req.query);

        if (!parsed.success) {
            return validationError(res, parsed.error);
        }

        try {
            const peerId = await findPeer(viewerId, req.params.username);

            const low = Math.min(viewerId, peerId);
            const high = Math.max(viewerId, peerId);

            // My own hidden-before: messages at or before it were deleted for me.
            // Compared in SQL (not round-tripped through JS) so clocks can't disagree.
            const myHiddenBefore =
                viewerId === low
                    ? conversations.lowHiddenBefore
                    : conversations.highHiddenBefore;

            const { before, limit } = parsed.data;

            // Fetch one extra row to know whether an older page exists.
            const rows = await db
                .select({
                    id: messages.id,
                    conversationId: messages.conversationId,
                    senderId: messages.senderId,
                    kind: messages.kind,
                    body: messages.body,
                    bodyEnc: messages.bodyEnc,
                    keyVersion: messages.keyVersion,
                    createdAt: messages.createdAt,
                })
                .from(messages)
                .innerJoin(
                    conversations,
                    eq(conversations.id, messages.conversationId)
                )
                .where(
                    and(
                        eq(conversations.userLowId, low),
                        eq(conversations.userHighId, high),
                        before !== undefined ? lt(messages.id, before) : undefined,
                        or(
                            isNull(myHiddenBefore),
                            gt(messages.createdAt, myHiddenBefore)
                        )
                    )
                )
                .orderBy(desc(messages.id))
                .limit(limit + 1);

            const page = rows.slice(0, limit);
            const oldest = page[page.length - 1];

            return res.json({
                messages: page
                    .reverse()
                    .map((row) => serializeMessage(row, viewerId)),
                nextCursor: rows.length > limit && oldest ? oldest.id : null,
            });
        } catch (error) {
            return handleError(res, error, "Message history");
        }
    }
);

/* ------------------------------------------------------------------ */
/* Mark read                                                           */
/* ------------------------------------------------------------------ */

// Moves my read marker to now(): everything the other person sent so far counts
// as read. Only my side changes. Idempotent: no thread yet is still a success.
router.post("/conversations/:username/read", requireAuth, async (req, res) => {
    const viewerId = req.session.userId;

    if (viewerId === undefined) {
        return res.status(401).json({ message: "Not authenticated" });
    }

    try {
        const peerId = await findPeer(viewerId, req.params.username);

        const low = Math.min(viewerId, peerId);
        const high = Math.max(viewerId, peerId);

        await db
            .update(conversations)
            .set(
                viewerId === low
                    ? { lowReadAt: sql`now()` }
                    : { highReadAt: sql`now()` }
            )
            .where(
                and(
                    eq(conversations.userLowId, low),
                    eq(conversations.userHighId, high)
                )
            );

        return res.json({ message: "Marked as read" });
    } catch (error) {
        return handleError(res, error, "Mark read");
    }
});

/* ------------------------------------------------------------------ */
/* Delete for me                                                       */
/* ------------------------------------------------------------------ */

// Deleting a chat hides it for me only: my hidden-before moves to now(), no
// rows are deleted, and the other person still sees everything. A new message
// after that makes the thread appear again, with only the new messages.
// Idempotent: no thread, or already hidden, is still a success.
router.delete("/conversations/:username", requireAuth, async (req, res) => {
    const viewerId = req.session.userId;

    if (viewerId === undefined) {
        return res.status(401).json({ message: "Not authenticated" });
    }

    try {
        const peerId = await findPeer(viewerId, req.params.username);

        const low = Math.min(viewerId, peerId);
        const high = Math.max(viewerId, peerId);

        await db
            .update(conversations)
            .set(
                viewerId === low
                    ? { lowHiddenBefore: sql`now()` }
                    : { highHiddenBefore: sql`now()` }
            )
            .where(
                and(
                    eq(conversations.userLowId, low),
                    eq(conversations.userHighId, high)
                )
            );

        return res.json({ message: "Conversation deleted" });
    } catch (error) {
        return handleError(res, error, "Delete conversation");
    }
});

export default router;