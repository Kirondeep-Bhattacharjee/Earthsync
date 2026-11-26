import { and, eq, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { db } from "../db/index.js";
import { conversations, messages } from "../db/schema.js";
import { HttpError } from "./http.js";
import { isBlockedEitherWay } from "./relationships.js";

/* ------------------------------------------------------------------ */
/* Choices                                                             */
/* ------------------------------------------------------------------ */

// The only timers a chat can have. null = off. The frontend shows the same list.
export const DISAPPEAR_CHOICES_SECONDS = [
    24 * 60 * 60, // 24 hours
    7 * 24 * 60 * 60, // 7 days
    90 * 24 * 60 * 60, // 90 days
] as const;

export function isAllowedTimer(seconds: number | null): boolean {
    return (
        seconds === null ||
        (DISAPPEAR_CHOICES_SECONDS as readonly number[]).includes(seconds)
    );
}

/* ------------------------------------------------------------------ */
/* The one visibility rule                                             */
/* ------------------------------------------------------------------ */

// "This message has not expired yet", as SQL. Every query that shows messages
// (history, inbox preview, unread, pins, stars, reply quotes) must include it, so
// an expired message disappears everywhere at the same moment. Compared with the
// database clock (now()), never a JS date, so clocks cannot disagree.
//
// Pass another column (for example the expires_at of an aliased copy of
// messages) to check that one instead.
export function notExpired(column: AnyPgColumn = messages.expiresAt) {
    return sql`(${column} is null or ${column} > now())`;
}

// The expiry for a message sent right now in a chat with this timer, as SQL for
// an INSERT. now() is the transaction time, the same value created_at gets, so
// expires_at = created_at + timer exactly. null timer = never expires.
export function expiryFor(afterSeconds: number | null) {
    return afterSeconds === null
        ? null
        : sql<Date>`now() + make_interval(secs => ${afterSeconds}::int)`;
}

/* ------------------------------------------------------------------ */
/* Changing the timer                                                  */
/* ------------------------------------------------------------------ */

// Sets the timer of the chat between me and the other person. Either person can
// change it. Returns the other person (for the live event) and whether anything
// changed (setting the same value again is a harmless no-op).
//
// The chat must already exist: a timer can't be stored without a conversation,
// and creating an empty one would make a blank thread appear in the other
// person's inbox. Blocked people get the same 404 as everywhere else.
//
// Older messages are NOT touched: their expires_at was stamped when they were sent.
export async function setDisappearTimer(
    viewerId: number,
    peerId: number,
    afterSeconds: number | null
): Promise<{ changed: boolean }> {
    if (!isAllowedTimer(afterSeconds)) {
        throw new HttpError(400, "That timer is not available");
    }

    if (await isBlockedEitherWay(viewerId, peerId)) {
        throw new HttpError(404, "User not found");
    }

    const low = Math.min(viewerId, peerId);
    const high = Math.max(viewerId, peerId);

    return db.transaction(async (tx) => {
        // The row is locked, so a message being sent at this very moment either
        // finishes first (with the old timer) or waits and gets the new one.
        const [conversation] = await tx
            .select({
                id: conversations.id,
                current: conversations.disappearAfterSeconds,
            })
            .from(conversations)
            .where(
                and(
                    eq(conversations.userLowId, low),
                    eq(conversations.userHighId, high)
                )
            )
            .limit(1)
            .for("update");

        if (!conversation) {
            throw new HttpError(
                409,
                "Send a message first, then you can turn on disappearing messages"
            );
        }

        if (conversation.current === afterSeconds) {
            return { changed: false };
        }

        await tx
            .update(conversations)
            .set({ disappearAfterSeconds: afterSeconds })
            .where(eq(conversations.id, conversation.id));

        return { changed: true };
    });
}

// The current timer of a thread (null = off, or no conversation yet).
export async function getDisappearTimer(
    viewerId: number,
    peerId: number
): Promise<number | null> {
    const [row] = await db
        .select({ seconds: conversations.disappearAfterSeconds })
        .from(conversations)
        .where(
            and(
                eq(conversations.userLowId, Math.min(viewerId, peerId)),
                eq(conversations.userHighId, Math.max(viewerId, peerId))
            )
        )
        .limit(1);

    return row?.seconds ?? null;
}
