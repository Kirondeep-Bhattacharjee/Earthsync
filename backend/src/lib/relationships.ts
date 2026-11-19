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

// One place for the profile-content rule: public profiles are open to anyone
// not blocked (blocks are checked by the caller), private ones to friends and
// the owner. Posts and, later, feeds use this too.
export function canViewFullProfile(
    visibility: "public" | "private",
    relationship: Relationship
): boolean {
    return (
        visibility === "public" ||
        relationship === "friend" ||
        relationship === "self"
    );
}