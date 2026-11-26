import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
    conversations,
    messageDeletions,
    messageStars,
    messages,
} from "../db/schema.js";
import { readMessageText, snippet, type MessageKind } from "./chat.js";
import { notExpired } from "./disappearing.js";
import { HttpError } from "./http.js";
import { isBlockedEitherWay } from "./relationships.js";

// Stars are private: only the person who starred a message sees it, and the
// other person is never told. A cap keeps the table and the panel sane.
export const MAX_STARS_LISTED = 200;

// What the Chat info panel needs. Photos and voice notes carry no text.
export type StarredMessage = {
    id: number;
    fromMe: boolean;
    kind: MessageKind;
    body: string | null;
    createdAt: Date;
    starredAt: Date;
    // When the starred message disappears (disappearing messages), or null. A
    // star does not stop a message from expiring.
    expiresAt: Date | null;
};

// Stars or unstars one message. Returns the other person (for the live event)
// and whether anything changed (starring twice, or unstarring something that is
// not starred, is a harmless no-op).
//
// Starring needs a message in a thread I am in that I can still see: not
// deleted for everyone, not deleted by me for myself, not hidden by deleting
// the chat. Unknown message, not in the thread and blocked all give the same
// 404. Unstarring only needs me to be in the thread.
export async function setStarred(
    viewerId: number,
    messageId: number,
    starred: boolean
): Promise<{ peerId: number; changed: boolean }> {
    const myHiddenBefore = sql`case when ${conversations.userLowId} = ${viewerId} then ${conversations.lowHiddenBefore} else ${conversations.highHiddenBefore} end`;

    const [row] = await db
        .select({
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

    if (!starred) {
        const removed = await db
            .delete(messageStars)
            .where(
                and(
                    eq(messageStars.messageId, messageId),
                    eq(messageStars.userId, viewerId)
                )
            )
            .returning({ id: messageStars.messageId });

        return { peerId, changed: removed.length > 0 };
    }

    // An expired message can't be starred (it is already gone).
    if (row.deletedAt !== null || row.hidden || !row.visible || row.expired) {
        throw new HttpError(404, "Message not found");
    }

    const added = await db
        .insert(messageStars)
        .values({ messageId, userId: viewerId })
        .onConflictDoNothing()
        .returning({ id: messageStars.messageId });

    return { peerId, changed: added.length > 0 };
}

// My starred messages in one thread, newest star first. A message that was
// deleted for everyone, or that I deleted for myself, is left out.
export async function listStars(
    viewerId: number,
    peerId: number
): Promise<StarredMessage[]> {
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
            starredAt: messageStars.createdAt,
        })
        .from(messageStars)
        .innerJoin(messages, eq(messages.id, messageStars.messageId))
        .innerJoin(
            conversations,
            eq(conversations.id, messages.conversationId)
        )
        .where(
            and(
                eq(messageStars.userId, viewerId),
                eq(conversations.userLowId, low),
                eq(conversations.userHighId, high),
                sql`${messages.deletedForEveryoneAt} is null`,
                notExpired(),
                sql`(${myHiddenBefore} is null or ${messages.createdAt} > ${myHiddenBefore})`,
                sql`not exists (select 1 from ${messageDeletions} where ${messageDeletions.messageId} = ${messages.id} and ${messageDeletions.userId} = ${viewerId})`
            )
        )
        .orderBy(desc(messageStars.createdAt))
        .limit(MAX_STARS_LISTED);

    return rows.map((row) => ({
        id: row.id,
        fromMe: row.senderId === viewerId,
        kind: row.kind,
        body: row.kind === "text" ? snippet(readMessageText(row)) : null,
        createdAt: row.createdAt,
        starredAt: row.starredAt,
        expiresAt: row.expiresAt,
    }));
}
