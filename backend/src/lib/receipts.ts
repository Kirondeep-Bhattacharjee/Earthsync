import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { db } from "../db/index.js";
import { conversations, messages, profiles } from "../db/schema.js";
import { isBlockedEitherWay } from "./relationships.js";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type ReceiptStatus = "sent" | "delivered" | "read";

// Sent to the person who SENT the messages. `username` is the other person in
// that thread (the recipient), and `upToId` is the newest of the sender's
// messages the new status covers. Clients only ever move a message forward
// (sent -> delivered -> read), never back.
export type ReceiptPush = {
    toUserId: number;
    event: {
        type: "receipt";
        username: string;
        status: "delivered" | "read";
        upToId: number;
    };
};

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

// "Read" is only shown when BOTH people have read receipts on (WhatsApp rule).
export async function receiptsMutual(a: number, b: number): Promise<boolean> {
    const rows = await db
        .select({ on: profiles.showReadReceipts })
        .from(profiles)
        .where(inArray(profiles.userId, [a, b]));

    return rows.length === 2 && rows.every((row) => row.on);
}

// The OTHER person's markers, seen from the viewer's side.
export function peerMarkers(viewerId: number, peerId: number) {
    const viewerIsLow = viewerId < peerId;

    return {
        delivered: viewerIsLow
            ? conversations.highDeliveredAt
            : conversations.lowDeliveredAt,
        read: viewerIsLow ? conversations.highReadAt : conversations.lowReadAt,
    };
}

// Status of one of MY messages, worked out in SQL like the unread count, so
// clocks cannot disagree. A read marker also implies delivered, so a message
// that was read while receipts are off still shows as delivered.
export function statusSql(
    mutual: boolean,
    peerDeliveredAt: AnyPgColumn,
    peerReadAt: AnyPgColumn
) {
    return sql<ReceiptStatus>`case
        when ${mutual}::boolean and ${peerReadAt} is not null and ${messages.createdAt} <= ${peerReadAt} then 'read'
        when (${peerDeliveredAt} is not null and ${messages.createdAt} <= ${peerDeliveredAt})
          or (${peerReadAt} is not null and ${messages.createdAt} <= ${peerReadAt}) then 'delivered'
        else 'sent'
    end`;
}

async function usernameOf(userId: number): Promise<string | null> {
    const [row] = await db
        .select({ username: profiles.username })
        .from(profiles)
        .where(eq(profiles.userId, userId))
        .limit(1);

    return row?.username ?? null;
}

// Newest message from `senderId` in a thread that `marker` already covers.
// max() of a bigint comes back as a string, hence the Number().
async function coveredUpToId(
    conversationId: number,
    senderId: number,
    marker: AnyPgColumn
): Promise<number | null> {
    const [row] = await db
        .select({ id: sql<string | null>`max(${messages.id})` })
        .from(messages)
        .innerJoin(conversations, eq(conversations.id, messages.conversationId))
        .where(
            and(
                eq(messages.conversationId, conversationId),
                eq(messages.senderId, senderId),
                sql`${messages.createdAt} <= ${marker}`
            )
        );

    return row?.id == null ? null : Number(row.id);
}

async function receiptPush(args: {
    conversationId: number;
    senderId: number;
    recipientId: number;
    status: "delivered" | "read";
    marker: AnyPgColumn;
}): Promise<ReceiptPush | null> {
    // A block must not leak activity in either direction.
    if (await isBlockedEitherWay(args.senderId, args.recipientId)) {
        return null;
    }

    const [username, upToId] = await Promise.all([
        usernameOf(args.recipientId),
        coveredUpToId(args.conversationId, args.senderId, args.marker),
    ]);

    if (!username || upToId === null) {
        return null;
    }

    return {
        toUserId: args.senderId,
        event: { type: "receipt", username, status: args.status, upToId },
    };
}

/* ------------------------------------------------------------------ */
/* Delivered                                                           */
/* ------------------------------------------------------------------ */

// The recipient has an open socket right now: their device has the message.
export async function markDelivered(
    conversationId: number,
    senderId: number,
    recipientId: number
): Promise<ReceiptPush[]> {
    const recipientIsLow = recipientId < senderId;

    await db
        .update(conversations)
        .set(
            recipientIsLow
                ? { lowDeliveredAt: sql`now()` }
                : { highDeliveredAt: sql`now()` }
        )
        .where(eq(conversations.id, conversationId));

    const push = await receiptPush({
        conversationId,
        senderId,
        recipientId,
        status: "delivered",
        marker: recipientIsLow
            ? conversations.lowDeliveredAt
            : conversations.highDeliveredAt,
    });

    return push ? [push] : [];
}

// A user just connected: everything that arrived while they were offline is
// delivered now. Only threads with something newer than their marker change.
export async function markDeliveredOnConnect(
    userId: number
): Promise<ReceiptPush[]> {
    const asLow = await db
        .update(conversations)
        .set({ lowDeliveredAt: sql`now()` })
        .where(
            and(
                eq(conversations.userLowId, userId),
                or(
                    isNull(conversations.lowDeliveredAt),
                    lt(conversations.lowDeliveredAt, conversations.lastMessageAt)
                )
            )
        )
        .returning({ id: conversations.id, peerId: conversations.userHighId });

    const asHigh = await db
        .update(conversations)
        .set({ highDeliveredAt: sql`now()` })
        .where(
            and(
                eq(conversations.userHighId, userId),
                or(
                    isNull(conversations.highDeliveredAt),
                    lt(conversations.highDeliveredAt, conversations.lastMessageAt)
                )
            )
        )
        .returning({ id: conversations.id, peerId: conversations.userLowId });

    const pushes = await Promise.all([
        ...asLow.map((row) =>
            receiptPush({
                conversationId: row.id,
                senderId: row.peerId,
                recipientId: userId,
                status: "delivered",
                marker: conversations.lowDeliveredAt,
            })
        ),
        ...asHigh.map((row) =>
            receiptPush({
                conversationId: row.id,
                senderId: row.peerId,
                recipientId: userId,
                status: "delivered",
                marker: conversations.highDeliveredAt,
            })
        ),
    ]);

    return pushes.filter((push): push is ReceiptPush => push !== null);
}

/* ------------------------------------------------------------------ */
/* Read                                                                */
/* ------------------------------------------------------------------ */

// Moves MY read marker (and delivered, since reading implies it). My marker
// keeps moving even with receipts off, because the unread badges use it. The
// other person is told "read" only when both of us have receipts on; otherwise
// they only learn "delivered".
export async function markRead(
    viewerId: number,
    peerId: number
): Promise<ReceiptPush[]> {
    const viewerIsLow = viewerId < peerId;

    const [row] = await db
        .update(conversations)
        .set(
            viewerIsLow
                ? { lowReadAt: sql`now()`, lowDeliveredAt: sql`now()` }
                : { highReadAt: sql`now()`, highDeliveredAt: sql`now()` }
        )
        .where(
            and(
                eq(conversations.userLowId, Math.min(viewerId, peerId)),
                eq(conversations.userHighId, Math.max(viewerId, peerId))
            )
        )
        .returning({ id: conversations.id });

    if (!row) {
        return [];
    }

    const mutual = await receiptsMutual(viewerId, peerId);

    const push = await receiptPush({
        conversationId: row.id,
        senderId: peerId,
        recipientId: viewerId,
        status: mutual ? "read" : "delivered",
        marker: mutual
            ? viewerIsLow
                ? conversations.lowReadAt
                : conversations.highReadAt
            : viewerIsLow
              ? conversations.lowDeliveredAt
              : conversations.highDeliveredAt,
    });

    return push ? [push] : [];
}