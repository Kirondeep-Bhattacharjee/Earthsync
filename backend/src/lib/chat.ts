import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import {
    conversations,
    friendships,
    media,
    messagePins,
    messageDeletions,
    messages,
    profiles,
} from "../db/schema.js";
import type { ProcessedChatMedia } from "./chat-media.js";
import { decryptText, encryptText, messageAad } from "./crypto.js";
import { expiryFor, notExpired } from "./disappearing.js";
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
    // Voice notes: about 48 loudness values (0 to 255) for the player's bars.
    // null for photos and for voice notes sent before this existed.
    waveform: number[] | null;
};

// The quote shown above a reply, as one viewer sees it. `body` is a short text
// snippet (text messages only); photos and voice notes are labelled by `kind`.
// `unavailable` = the original was deleted (for everyone, or by this viewer for
// themselves): no content is sent, only the fact that it is gone.
export type ReplyPreview = {
    id: number;
    fromMe: boolean;
    kind: MessageKind;
    body: string | null;
    unavailable: boolean;
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
    deleted: boolean; // deleted for everyone: body and media are null
    starred: boolean; // starred by ME (private, never sent to the other person)
    replyTo: ReplyPreview | null;
    // Disappearing messages: when this message stops being shown. null = never.
    // Clients remove it from the screen at this time without a refresh.
    expiresAt: Date | null;
};

// The message a new message replies to, as found when sending. senderId lets
// each side work out "you" vs "them" in the quote.
export type ReplyTarget = {
    id: number;
    senderId: number;
    kind: MessageKind;
    body: string | null; // short snippet of a text message, otherwise null
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
    replyTo: ReplyTarget | null;
    expiresAt: Date | null;
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
    deletedForEveryoneAt?: Date | null;
    expiresAt?: Date | null;
};

/* ------------------------------------------------------------------ */
/* Reading and serializing                                             */
/* ------------------------------------------------------------------ */

const UNREADABLE_TEXT = "This message can't be displayed";

// How much of the original a reply quote carries.
const REPLY_SNIPPET_LENGTH = 120;

export function snippet(text: string | null): string | null {
    if (text === null) {
        return null;
    }

    const flat = text.replace(/\s+/g, " ").trim();

    return flat.length > REPLY_SNIPPET_LENGTH
        ? `${flat.slice(0, REPLY_SNIPPET_LENGTH - 1)}…`
        : flat;
}

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

// The quote for a reply in history, built from the original's stored row.
// `original` is null when the row is gone. `hiddenForViewer` = the viewer
// deleted the original for themselves.
export function replyPreviewFromRow(
    original: StoredMessage | null,
    hiddenForViewer: boolean,
    viewerId: number
): ReplyPreview | null {
    if (!original) {
        return null;
    }

    if (original.deletedForEveryoneAt != null || hiddenForViewer) {
        return {
            id: original.id,
            fromMe: original.senderId === viewerId,
            kind: original.kind,
            body: null,
            unavailable: true,
        };
    }

    return {
        id: original.id,
        fromMe: original.senderId === viewerId,
        kind: original.kind,
        body: original.kind === "text" ? snippet(readMessageText(original)) : null,
        unavailable: false,
    };
}

// A stored message as one viewer should see it. Every read path uses this, so
// anything that has to change per viewer (for example masking a blocked
// person) changes in one place.
export function serializeMessage(
    row: StoredMessage,
    viewerId: number,
    media: ChatMedia | null = null,
    status: ReceiptStatus = "sent",
    replyTo: ReplyPreview | null = null,
    starred = false
): ChatMessage {
    const fromMe = row.senderId === viewerId;
    // Deleted for everyone: the row stays in the database for now, but no
    // content ever leaves the server.
    const deleted = row.deletedForEveryoneAt != null;

    return {
        id: row.id,
        kind: row.kind,
        body: !deleted && row.kind === "text" ? readMessageText(row) : null,
        media: deleted ? null : media,
        createdAt: row.createdAt,
        fromMe,
        status: fromMe ? status : null,
        deleted,
        starred: deleted ? false : starred,
        replyTo: deleted ? null : replyTo,
        expiresAt: row.expiresAt ?? null,
    };
}

// The same shape for a message that was just sent.
export function chatMessageFromSent(
    sent: SentMessage,
    fromMe: boolean
): ChatMessage {
    const viewerId = fromMe ? sent.senderId : sent.recipientId;

    return {
        id: sent.id,
        kind: sent.kind,
        body: sent.body,
        media: sent.media,
        createdAt: sent.createdAt,
        fromMe,
        status: fromMe ? "sent" : null,
        deleted: false,
        starred: false,
        replyTo: sent.replyTo
            ? {
                  id: sent.replyTo.id,
                  fromMe: sent.replyTo.senderId === viewerId,
                  kind: sent.replyTo.kind,
                  body: sent.replyTo.body,
                  unavailable: false,
              }
            : null,
        expiresAt: sent.expiresAt,
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

// The original of a reply. It must be in THIS thread, still exist, and be
// visible to the sender: not deleted for everyone, not deleted by the sender
// for themselves, and not hidden by the sender deleting the chat. Anything else
// is the same 404, so a client can't probe other people's messages by id.
// No replyToId = a normal message (null).
async function findReplyTarget(
    senderId: number,
    recipientId: number,
    replyToId: number | undefined
): Promise<ReplyTarget | null> {
    if (replyToId === undefined) {
        return null;
    }

    const low = Math.min(senderId, recipientId);
    const high = Math.max(senderId, recipientId);

    const senderHiddenBefore =
        senderId === low
            ? conversations.lowHiddenBefore
            : conversations.highHiddenBefore;

    const [row] = await db
        .select({
            id: messages.id,
            conversationId: messages.conversationId,
            senderId: messages.senderId,
            kind: messages.kind,
            body: messages.body,
            bodyEnc: messages.bodyEnc,
            keyVersion: messages.keyVersion,
            createdAt: messages.createdAt,
            deletedAt: messages.deletedForEveryoneAt,
            hidden: sql<boolean>`exists (select 1 from ${messageDeletions} where ${messageDeletions.messageId} = ${messages.id} and ${messageDeletions.userId} = ${senderId})`,
        })
        .from(messages)
        .innerJoin(conversations, eq(conversations.id, messages.conversationId))
        .where(
            and(
                eq(messages.id, replyToId),
                eq(conversations.userLowId, low),
                eq(conversations.userHighId, high),
                or(
                    isNull(senderHiddenBefore),
                    gt(messages.createdAt, senderHiddenBefore)
                ),
                // An expired message can't be replied to.
                notExpired()
            )
        )
        .limit(1);

    if (!row || row.deletedAt !== null || row.hidden) {
        throw new HttpError(404, "The message you are replying to is not available");
    }

    return {
        id: row.id,
        senderId: row.senderId,
        kind: row.kind,
        body: row.kind === "text" ? snippet(readMessageText(row)) : null,
    };
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
//   - a reply (replyToId) must point at a live message in this same thread
//
// The block check is repeated here even though findPeer() does it, because the
// WebSocket path will pass ids, not usernames.
export async function sendMessage(
    senderId: number,
    recipientId: number,
    rawBody: unknown,
    replyToId?: number
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

    const replyTo = await findReplyTarget(senderId, recipientId, replyToId);

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
            .returning({
                id: conversations.id,
                // Read in the same statement that locks the row, so a timer
                // change at this very moment is either seen or waits for us.
                disappearAfterSeconds: conversations.disappearAfterSeconds,
            });

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
                replyToId: replyTo?.id,
                expiresAt: expiryFor(conversation.disappearAfterSeconds),
            })
            .returning({
                id: messages.id,
                createdAt: messages.createdAt,
                expiresAt: messages.expiresAt,
            });

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
            replyTo,
            expiresAt: message.expiresAt,
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
    waveform?: number[] | null;
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
        waveform: row.waveform ?? null,
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
// deletes the files if this throws (including a reply to a message that is no
// longer available).
export async function sendAttachment(
    senderId: number,
    recipientId: number,
    upload: {
        key: string;
        thumbKey: string | null;
        processed: ProcessedChatMedia;
    },
    replyToId?: number
): Promise<SentMessage> {
    const { key, thumbKey, processed } = upload;

    if (senderId === recipientId) {
        throw new HttpError(400, "You can't message yourself");
    }

    if (await isBlockedEitherWay(senderId, recipientId)) {
        throw new HttpError(404, "User not found");
    }

    const replyTo = await findReplyTarget(senderId, recipientId, replyToId);

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
            .returning({
                id: conversations.id,
                disappearAfterSeconds: conversations.disappearAfterSeconds,
            });

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
                waveform: processed.waveform,
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
                replyToId: replyTo?.id,
                expiresAt: expiryFor(conversation.disappearAfterSeconds),
            })
            .returning({
                id: messages.id,
                createdAt: messages.createdAt,
                expiresAt: messages.expiresAt,
            });

        if (!row) {
            throw new Error("Message insert returned no row");
        }

        return {
            id: row.id,
            conversationId: conversation.id,
            createdAt: row.createdAt,
            expiresAt: row.expiresAt,
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
            waveform: processed.waveform,
        }),
        createdAt: saved.createdAt,
        replyTo,
        expiresAt: saved.expiresAt,
    };
}

/* ------------------------------------------------------------------ */
/* Deleting a message                                                  */
/* ------------------------------------------------------------------ */

export type DeleteScope = "me" | "everyone";

// How long "delete for everyone" stays available. Enforced here, in SQL; the
// frontend only decides whether to show the option.
export const DELETE_FOR_EVERYONE_HOURS = 48;

// "me": hides the message for the viewer only (any message in a thread they are
// in). "everyone": the sender only, within 48 hours; both people get a
// placeholder. Returns the other person so the caller can push live events.
// Unknown message, not in the thread, and blocked all give the same 404.
export async function deleteMessage(
    viewerId: number,
    messageId: number,
    scope: DeleteScope
): Promise<{ peerId: number }> {
    const [row] = await db
        .select({
            senderId: messages.senderId,
            deletedAt: messages.deletedForEveryoneAt,
            userLowId: conversations.userLowId,
            userHighId: conversations.userHighId,
            expired: sql<boolean>`not ${notExpired()}`,
            // Compared in SQL so clocks can't disagree.
            inWindow: sql<boolean>`${messages.createdAt} > now() - ${sql.raw(
                `interval '${DELETE_FOR_EVERYONE_HOURS} hours'`
            )}`,
        })
        .from(messages)
        .innerJoin(conversations, eq(conversations.id, messages.conversationId))
        .where(eq(messages.id, messageId))
        .limit(1);

    // An expired message is already gone for both people: same 404.
    if (
        !row ||
        row.expired ||
        (row.userLowId !== viewerId && row.userHighId !== viewerId)
    ) {
        throw new HttpError(404, "Message not found");
    }

    const peerId = row.userLowId === viewerId ? row.userHighId : row.userLowId;

    if (await isBlockedEitherWay(viewerId, peerId)) {
        throw new HttpError(404, "Message not found");
    }

    if (scope === "me") {
        // Idempotent: hiding twice is fine.
        await db
            .insert(messageDeletions)
            .values({ messageId, userId: viewerId })
            .onConflictDoNothing();

        return { peerId };
    }

    if (row.senderId !== viewerId) {
        throw new HttpError(
            403,
            "You can only delete your own messages for everyone"
        );
    }

    if (!row.inWindow) {
        throw new HttpError(
            403,
            `You can only delete a message for everyone within ${DELETE_FOR_EVERYONE_HOURS} hours of sending`
        );
    }

    // Already deleted: nothing to do (idempotent).
    await db
        .update(messages)
        .set({ deletedForEveryoneAt: sql`now()` })
        .where(
            and(eq(messages.id, messageId), isNull(messages.deletedForEveryoneAt))
        );

    // A deleted message can't stay pinned.
    await db.delete(messagePins).where(eq(messagePins.messageId, messageId));

    return { peerId };
}