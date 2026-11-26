import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
    conversations,
    messageDeletions,
    messagePins,
    messages,
} from "../db/schema.js";
import { readMessageText, snippet, type MessageKind } from "./chat.js";
import { notExpired } from "./disappearing.js";
import { HttpError } from "./http.js";
import { isBlockedEitherWay } from "./relationships.js";

// A pin is shared: both people see it, and either of them can add or remove
// one. Capped per chat so the pinned bar stays useful.
export const MAX_PINS_PER_CHAT = 3;

// What the pinned bar needs. Photos and voice notes carry no text, only a kind.
export type PinnedMessage = {
    id: number;
    fromMe: boolean;
    kind: MessageKind;
    body: string | null;
    createdAt: Date;
    pinnedAt: Date;
    // When the pinned message disappears (disappearing messages), or null. A
    // pin does not stop a message from expiring.
    expiresAt: Date | null;
};

// Pins or unpins one message. Returns the other person (so the caller can push
// a live event) and whether anything actually changed (pinning twice, or
// unpinning something that is not pinned, is a harmless no-op).
//
// Pinning needs a message in a thread I am in, that I can still see: not
// deleted for everyone, not deleted by me for myself, and not hidden by me
// deleting the chat. Unknown message, not in the thread and blocked all give
// the same 404. The 4th pin is refused with a 409.
export async function setPinned(
    viewerId: number,
    messageId: number,
    pinned: boolean
): Promise<{ peerId: number; changed: boolean }> {
    // My own hidden-before, picked in SQL by which side of the pair I am on.
    const myHiddenBefore = sql`case when ${conversations.userLowId} = ${viewerId} then ${conversations.lowHiddenBefore} else ${conversations.highHiddenBefore} end`;

    const [row] = await db
        .select({
            conversationId: messages.conversationId,
            deletedAt: messages.deletedForEveryoneAt,
            userLowId: conversations.userLowId,
            userHighId: conversations.userHighId,
            hidden: sql<boolean>`exists (select 1 from ${messageDeletions} where ${messageDeletions.messageId} = ${messages.id} and ${messageDeletions.userId} = ${viewerId})`,
            visible: sql<boolean>`(${myHiddenBefore} is null or ${messages.createdAt} > ${myHiddenBefore})`,
            expired: sql<boolean>`not ${notExpired()}`,
        })
        .from(messages)
        .innerJoin(conversations, eq(conversations.id, messages.conversationId))
        .where(eq(messages.id, messageId))
        .limit(1);

    if (!row || (row.userLowId !== viewerId && row.userHighId !== viewerId)) {
        throw new HttpError(404, "Message not found");
    }

    const peerId = row.userLowId === viewerId ? row.userHighId : row.userLowId;

    if (await isBlockedEitherWay(viewerId, peerId)) {
        throw new HttpError(404, "Message not found");
    }

    if (!pinned) {
        const removed = await db
            .delete(messagePins)
            .where(eq(messagePins.messageId, messageId))
            .returning({ id: messagePins.messageId });

        return { peerId, changed: removed.length > 0 };
    }

    // An expired message can't be pinned (it is already gone).
    if (row.deletedAt !== null || row.hidden || !row.visible || row.expired) {
        throw new HttpError(404, "Message not found");
    }

    return db.transaction(async (tx) => {
        // The conversation row is locked for the rest of this transaction, so
        // two people pinning at the same moment can't both slip past the cap.
        await tx
            .select({ id: conversations.id })
            .from(conversations)
            .where(eq(conversations.id, row.conversationId))
            .for("update");

        const existing = await tx
            .select({ id: messagePins.messageId })
            .from(messagePins)
            .where(eq(messagePins.conversationId, row.conversationId));

        if (existing.some((pin) => pin.id === messageId)) {
            return { peerId, changed: false };
        }

        if (existing.length >= MAX_PINS_PER_CHAT) {
            throw new HttpError(
                409,
                `You can pin up to ${MAX_PINS_PER_CHAT} messages in a chat. Unpin one first.`
            );
        }

        await tx.insert(messagePins).values({
            messageId,
            conversationId: row.conversationId,
            pinnedBy: viewerId,
        });

        return { peerId, changed: true };
    });
}

// The pins of one thread as I should see them, newest pin first. A pinned
// message that was deleted for everyone, or that I deleted for myself, is left
// out (and a delete-for-everyone removes the pin itself, see deleteMessage).
export async function listPins(
    viewerId: number,
    peerId: number
): Promise<PinnedMessage[]> {
    const low = Math.min(viewerId, peerId);
    const high = Math.max(viewerId, peerId);

    const myHiddenBefore =
        viewerId === low
            ? conversations.lowHiddenBefore
            : conversations.highHiddenBefore;

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
            expiresAt: messages.expiresAt,
            pinnedAt: messagePins.createdAt,
        })
        .from(messagePins)
        .innerJoin(messages, eq(messages.id, messagePins.messageId))
        .innerJoin(
            conversations,
            eq(conversations.id, messagePins.conversationId)
        )
        .where(
            and(
                eq(conversations.userLowId, low),
                eq(conversations.userHighId, high),
                sql`${messages.deletedForEveryoneAt} is null`,
                notExpired(),
                sql`(${myHiddenBefore} is null or ${messages.createdAt} > ${myHiddenBefore})`,
                sql`not exists (select 1 from ${messageDeletions} where ${messageDeletions.messageId} = ${messages.id} and ${messageDeletions.userId} = ${viewerId})`
            )
        )
        .orderBy(desc(messagePins.createdAt));

    return rows.map((row) => ({
        id: row.id,
        fromMe: row.senderId === viewerId,
        kind: row.kind,
        body: row.kind === "text" ? snippet(readMessageText(row)) : null,
        createdAt: row.createdAt,
        pinnedAt: row.pinnedAt,
        expiresAt: row.expiresAt,
    }));
}
