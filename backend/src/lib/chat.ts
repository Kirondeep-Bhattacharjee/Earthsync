import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import {
    conversations,
    friendships,
    media,
    messages,
    profiles,
} from "../db/schema.js";
import type { ProcessedChatMedia } from "./chat-media.js";
import { decryptText, encryptText, messageAad } from "./crypto.js";
import { HttpError } from "./http.js";
import { signChatUrl } from "./r2.js";
import { areFriends, isBlockedEitherWay } from "./relationships.js";
import { usernameSchema } from "./username.js";
import type { ReceiptStatus } from "./receipts.js";

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

export type MessageKind = "text" | "image" | "voice";

// Filled in when image and voice messages arrive.
export type ChatMedia = {
    url: string;
    thumbUrl: string | null;
    width: number | null;
    height: number | null;
    durationSeconds: number | null;
};

// What the API and the WebSocket send to a client. One shape for history, the
// REST send response and live pushes, built only by the helpers below.
export type ChatMessage = {
    id: number;
    kind: MessageKind;
    body: string | null; // null for image and voice messages
    media: ChatMedia | null;
    createdAt: Date;
    fromMe: boolean;
    status: ReceiptStatus | null; // only for my own messages
};

export type SentMessage = {
    id: number;
    conversationId: number;
    senderId: number;
    recipientId: number; // the WebSocket layer pushes to this user's open sockets
    kind: MessageKind;
    body: string | null; // plaintext, in memory only; the database holds ciphertext
    media: ChatMedia | null;
    createdAt: Date;
};

// A messages row as it is stored.
export type StoredMessage = {
    id: number;
    conversationId: number;
    senderId: number;
    kind: MessageKind;
    body: string | null; // legacy plaintext, until the backfill has run
    bodyEnc: string | null;
    keyVersion: number | null;
    createdAt: Date;
};

/* ------------------------------------------------------------------ */
/* Reading and serializing                                             */
/* ------------------------------------------------------------------ */

const UNREADABLE_TEXT = "This message can't be displayed";

// The text of a stored message. Encrypted rows are decrypted; rows from before
// encryption still have plaintext in `body`. A row that cannot be decrypted
// (wrong key, damaged data) is logged and shown as a placeholder, so one bad
// row never breaks a whole page of history.
export function readMessageText(row: StoredMessage): string | null {
    if (row.bodyEnc === null) {
        return row.body;
    }

    try {
        if (row.keyVersion === null) {
            throw new Error("missing key_version");
        }

        return decryptText(
            row.bodyEnc,
            row.keyVersion,
            messageAad(row.conversationId, row.senderId)
        );
    } catch (error) {
        console.error(`Could not decrypt message ${row.id}:`, error);
        return UNREADABLE_TEXT;
    }
}

// A stored message as one viewer should see it. Every read path uses this, so
// anything that has to change per viewer (for example masking a blocked
// person) changes in one place.
export function serializeMessage(
    row: StoredMessage,
    viewerId: number,
    media: ChatMedia | null = null,
    status: ReceiptStatus = "sent"
): ChatMessage {
    const fromMe = row.senderId === viewerId;

    return {
        id: row.id,
        kind: row.kind,
        body: row.kind === "text" ? readMessageText(row) : null,
        media,
        createdAt: row.createdAt,
        fromMe,
        status: fromMe ? status : null,
    };
}

// The same shape for a message that was just sent.
export function chatMessageFromSent(
    sent: SentMessage,
    fromMe: boolean
): ChatMessage {
    return {
        id: sent.id,
        kind: sent.kind,
        body: sent.body,
        media: sent.media,
        createdAt: sent.createdAt,
        fromMe,
        status: fromMe ? "sent" : null,
    };
}

// One line for the inbox row: the text itself, or a label for attachments.
export function previewText(kind: MessageKind, body: string | null): string {
    if (kind === "image") {
        return "Photo";
    }

    if (kind === "voice") {
        return "Voice message";
    }

    return body ?? "";
}

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

// The only place a text message is created. Every entry point (REST and
// WebSocket) must call this, so the rules live once:
//   - the sender comes from the session, never from the client
//   - anyone who is not blocked can send TEXT to anyone: friendship is NOT
//     checked here (photos and voice notes are friends only, see below)
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
        // Text is stored encrypted; the plaintext never reaches the database.
        const { bodyEnc, keyVersion } = encryptText(
            body.data,
            messageAad(conversation.id, senderId)
        );

        const [message] = await tx
            .insert(messages)
            .values({
                conversationId: conversation.id,
                senderId,
                kind: "text",
                bodyEnc,
                keyVersion,
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
            kind: "text",
            body: body.data,
            media: null,
            createdAt: message.createdAt,
        };
    });
}

/* ------------------------------------------------------------------ */
/* Attachments (friends only)                                          */
/* ------------------------------------------------------------------ */

const NOT_FRIENDS = "Photos and voice messages are only for friends";

// Signs the URLs for one stored attachment. Call it only after the viewer was
// checked: a participant of the conversation, not blocked.
export async function buildChatMedia(row: {
    key: string;
    thumbKey: string | null;
    width: number | null;
    height: number | null;
    durationSeconds: number | null;
}): Promise<ChatMedia> {
    const [url, thumbUrl] = await Promise.all([
        signChatUrl(row.key),
        row.thumbKey ? signChatUrl(row.thumbKey) : Promise.resolve(null),
    ]);

    return {
        url,
        thumbUrl,
        width: row.width,
        height: row.height,
        durationSeconds: row.durationSeconds,
    };
}

// The cheap early check, so a stranger is refused before any image or audio
// processing runs. sendAttachment repeats the friendship check under a lock.
export async function assertCanSendAttachment(
    senderId: number,
    recipientId: number
): Promise<void> {
    if (senderId === recipientId) {
        throw new HttpError(400, "You can't message yourself");
    }

    if (await isBlockedEitherWay(senderId, recipientId)) {
        throw new HttpError(404, "User not found");
    }

    if (!(await areFriends(senderId, recipientId))) {
        throw new HttpError(403, NOT_FRIENDS);
    }
}

// Saves an image or voice message whose files are already in R2. The caller
// deletes the files if this throws.
export async function sendAttachment(
    senderId: number,
    recipientId: number,
    upload: {
        key: string;
        thumbKey: string | null;
        processed: ProcessedChatMedia;
    }
): Promise<SentMessage> {
    const { key, thumbKey, processed } = upload;

    if (senderId === recipientId) {
        throw new HttpError(400, "You can't message yourself");
    }

    if (await isBlockedEitherWay(senderId, recipientId)) {
        throw new HttpError(404, "User not found");
    }

    const low = Math.min(senderId, recipientId);
    const high = Math.max(senderId, recipientId);
    const kind: MessageKind = processed.type === "image" ? "image" : "voice";

    const saved = await db.transaction(async (tx) => {
        // The friendship row is locked until this transaction ends, so an
        // unfriend or block (which deletes it) can't slip in between this
        // check and the insert. It waits, then happens right after.
        const [friendship] = await tx
            .select({ id: friendships.id })
            .from(friendships)
            .where(
                and(
                    eq(friendships.userLowId, low),
                    eq(friendships.userHighId, high)
                )
            )
            .limit(1)
            .for("share");

        if (!friendship) {
            throw new HttpError(403, NOT_FRIENDS);
        }

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

        const [mediaRow] = await tx
            .insert(media)
            .values({
                userId: senderId,
                key,
                thumbKey,
                type: processed.type,
                contentType: processed.contentType,
                sizeBytes: processed.body.length,
                width: processed.width,
                height: processed.height,
                durationSeconds: processed.durationSeconds,
                sha256: processed.sha256,
                status: "ready",
            })
            .returning({ id: media.id });

        if (!mediaRow) {
            throw new Error("Media insert returned no row");
        }

        const [row] = await tx
            .insert(messages)
            .values({
                conversationId: conversation.id,
                senderId,
                kind,
                mediaId: mediaRow.id,
            })
            .returning({ id: messages.id, createdAt: messages.createdAt });

        if (!row) {
            throw new Error("Message insert returned no row");
        }

        return {
            id: row.id,
            conversationId: conversation.id,
            createdAt: row.createdAt,
        };
    });

    return {
        id: saved.id,
        conversationId: saved.conversationId,
        senderId,
        recipientId,
        kind,
        body: null,
        media: await buildChatMedia({
            key,
            thumbKey,
            width: processed.width,
            height: processed.height,
            durationSeconds: processed.durationSeconds,
        }),
        createdAt: saved.createdAt,
    };
}