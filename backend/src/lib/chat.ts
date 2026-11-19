import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import { conversations, messages, profiles } from "../db/schema.js";
import { HttpError } from "./http.js";
import { isBlockedEitherWay } from "./relationships.js";
import { usernameSchema } from "./username.js";

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

export const MAX_MESSAGE_LENGTH = 2000;

// One rule for a message body, shared by the REST route and (later) the
// WebSocket handler. Trimmed, so "   " counts as empty.
export const messageBodySchema = z
    .string()
    .trim()
    .min(1, "Message can't be empty")
    .max(
        MAX_MESSAGE_LENGTH,
        `Message must be ${MAX_MESSAGE_LENGTH} characters or fewer`
    );

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type SentMessage = {
    id: number;
    conversationId: number;
    senderId: number;
    recipientId: number; // the WebSocket layer pushes to this user's open sockets
    body: string;
    createdAt: Date;
};

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

// Resolves the other person in a chat from a username. An unknown username, a
// malformed one and a blocked one all give the same 404, so a block never
// reveals that the account exists (same rule as friends.ts and profile.ts).
export async function findPeer(
    viewerId: number,
    rawUsername: unknown
): Promise<number> {
    const username = usernameSchema.safeParse(rawUsername);

    if (!username.success) {
        throw new HttpError(404, "User not found");
    }

    const [peer] = await db
        .select({ id: profiles.userId })
        .from(profiles)
        .where(eq(profiles.username, username.data))
        .limit(1);

    if (!peer || (await isBlockedEitherWay(viewerId, peer.id))) {
        throw new HttpError(404, "User not found");
    }

    return peer.id;
}

/* ------------------------------------------------------------------ */
/* Sending                                                             */
/* ------------------------------------------------------------------ */

// The only place a message is created. Every entry point (REST now, WebSocket
// later) must call this, so the rules live once:
//   - the sender comes from the session, never from the client
//   - anyone who is not blocked can message anyone: friendship is NOT checked
//     (it only gates profile content; see the conversations comment in schema.ts)
//   - the thread is created on the first message, and last_message_at moves in
//     the same transaction so the inbox can sort without scanning messages
//
// The block check is repeated here even though findPeer() does it, because the
// WebSocket path will pass ids, not usernames.
export async function sendMessage(
    senderId: number,
    recipientId: number,
    rawBody: unknown
): Promise<SentMessage> {
    const body = messageBodySchema.safeParse(rawBody);

    if (!body.success) {
        throw new HttpError(
            400,
            body.error.issues[0]?.message ?? "Invalid message"
        );
    }

    if (senderId === recipientId) {
        throw new HttpError(400, "You can't message yourself");
    }

    if (await isBlockedEitherWay(senderId, recipientId)) {
        throw new HttpError(404, "User not found");
    }

    // Conversations store the smaller id first (check constraint).
    const low = Math.min(senderId, recipientId);
    const high = Math.max(senderId, recipientId);

    return db.transaction(async (tx) => {
        // Create the thread or, if it exists, touch last_message_at. One
        // statement, so two people messaging each other for the first time at
        // the same moment end up in the same thread.
        const [conversation] = await tx
            .insert(conversations)
            .values({ userLowId: low, userHighId: high })
            .onConflictDoUpdate({
                target: [conversations.userLowId, conversations.userHighId],
                set: { lastMessageAt: sql`now()` },
            })
            .returning({ id: conversations.id });

        if (!conversation) {
            throw new Error("Conversation upsert returned no row");
        }

        // created_at defaults to now() too, which is the transaction time, so it
        // equals last_message_at exactly. The inbox relies on that.
        const [message] = await tx
            .insert(messages)
            .values({
                conversationId: conversation.id,
                senderId,
                body: body.data,
            })
            .returning({ id: messages.id, createdAt: messages.createdAt });

        if (!message) {
            throw new Error("Message insert returned no row");
        }

        return {
            id: message.id,
            conversationId: conversation.id,
            senderId,
            recipientId,
            body: body.data,
            createdAt: message.createdAt,
        };
    });
}