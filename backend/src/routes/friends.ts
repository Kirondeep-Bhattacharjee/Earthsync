import { Router } from "express";
import { and, asc, count, desc, eq, or, sql } from "drizzle-orm";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { db } from "../db/index.js";
import { friendRequests, friendships, profiles } from "../db/schema.js";
import { requireAuth } from "../middlewares/requireAuth.js";
import {
    HttpError,
    handleError,
    uniqueViolation,
    validationError,
} from "../lib/http.js";
import { getRelationship, isBlockedEitherWay } from "../lib/relationships.js";
import { usernameSchema } from "../lib/username.js";

const router = Router();

const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL;

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

const sendRequestSchema = z.object({
    username: usernameSchema,
});

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

// Columns that are safe to send to the client for a person in a list.
// No email and no bio.
const person = {
    username: profiles.username,
    visibility: profiles.visibility,
    profilePictureKey: profiles.profilePictureKey,
};

type PersonRow = {
    username: string;
    visibility: "public" | "private";
    profilePictureKey: string | null;
    since: Date;
};

// `since` is when the request was sent, or when the two became friends.
function toPerson(row: PersonRow) {
    return {
        username: row.username,
        visibility: row.visibility,
        profilePictureUrl:
            row.profilePictureKey && R2_PUBLIC_URL
                ? `${R2_PUBLIC_URL}/${row.profilePictureKey}`
                : null,
        since: row.since,
    };
}

// Finds the user a route acts on. An unknown username, a malformed one and a
// blocked one all give the same 404, so a block never reveals that the
// account exists (same rule as GET /profile/:username).
async function findTarget(viewerId: number, rawUsername: unknown): Promise<number> {
    const username = usernameSchema.safeParse(rawUsername);

    if (!username.success) {
        throw new HttpError(404, "User not found");
    }

    const [target] = await db
        .select({ id: profiles.userId })
        .from(profiles)
        .where(eq(profiles.username, username.data))
        .limit(1);

    if (!target || (await isBlockedEitherWay(viewerId, target.id))) {
        throw new HttpError(404, "User not found");
    }

    return target.id;
}

// Friend requests can be used to pester people, so sending is limited.
const sendRequestLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => String(req.session.userId ?? "anonymous"),
    message: { message: "Too many friend requests. Try again later." },
});

/* ------------------------------------------------------------------ */
/* Friend requests                                                     */
/* ------------------------------------------------------------------ */

// Send a request. Every response that changes the relationship also returns
// the new `relationship`, so the profile page can update its buttons.
router.post(
    "/friend-requests",
    requireAuth,
    sendRequestLimiter,
    async (req, res) => {
        const viewerId = req.session.userId;

        if (viewerId === undefined) {
            return res.status(401).json({ message: "Not authenticated" });
        }

        const parsed = sendRequestSchema.safeParse(req.body);

        if (!parsed.success) {
            return validationError(res, parsed.error);
        }

        try {
            const targetId = await findTarget(viewerId, parsed.data.username);

            if (targetId === viewerId) {
                throw new HttpError(
                    400,
                    "You can't send a friend request to yourself"
                );
            }

            const relationship = await getRelationship(viewerId, targetId);

            if (relationship === "friend") {
                throw new HttpError(409, "You are already friends");
            }

            if (relationship === "request_sent") {
                throw new HttpError(
                    409,
                    "You already sent this person a friend request"
                );
            }

            if (relationship === "request_received") {
                throw new HttpError(
                    409,
                    "This person already sent you a request. Accept it from Requests"
                );
            }

            await db
                .insert(friendRequests)
                .values({ senderId: viewerId, receiverId: targetId });

            return res.status(201).json({
                message: "Friend request sent",
                relationship: "request_sent",
            });
        } catch (error) {
            // Two requests at the same moment: the pair index lets only one through.
            if (uniqueViolation(error)) {
                return res.status(409).json({
                    message: "A request between you two is already pending",
                });
            }

            return handleError(res, error, "Send friend request");
        }
    }
);

// Requests other people sent to me, newest first.
router.get("/friend-requests/incoming", requireAuth, async (req, res) => {
    const viewerId = req.session.userId;

    if (viewerId === undefined) {
        return res.status(401).json({ message: "Not authenticated" });
    }

    try {
        const rows = await db
            .select({ ...person, since: friendRequests.createdAt })
            .from(friendRequests)
            .innerJoin(profiles, eq(profiles.userId, friendRequests.senderId))
            .where(eq(friendRequests.receiverId, viewerId))
            .orderBy(desc(friendRequests.createdAt));

        return res.status(200).json({ requests: rows.map(toPerson) });
    } catch (error) {
        return handleError(res, error, "List incoming requests");
    }
});

// Requests I sent that are still pending, newest first.
router.get("/friend-requests/outgoing", requireAuth, async (req, res) => {
    const viewerId = req.session.userId;

    if (viewerId === undefined) {
        return res.status(401).json({ message: "Not authenticated" });
    }

    try {
        const rows = await db
            .select({ ...person, since: friendRequests.createdAt })
            .from(friendRequests)
            .innerJoin(profiles, eq(profiles.userId, friendRequests.receiverId))
            .where(eq(friendRequests.senderId, viewerId))
            .orderBy(desc(friendRequests.createdAt));

        return res.status(200).json({ requests: rows.map(toPerson) });
    } catch (error) {
        return handleError(res, error, "List outgoing requests");
    }
});

// Number of incoming requests, for the sidebar badge.
router.get("/friend-requests/count", requireAuth, async (req, res) => {
    const viewerId = req.session.userId;

    if (viewerId === undefined) {
        return res.status(401).json({ message: "Not authenticated" });
    }

    try {
        const [row] = await db
            .select({ incoming: count() })
            .from(friendRequests)
            .where(eq(friendRequests.receiverId, viewerId));

        return res.status(200).json({ incoming: row?.incoming ?? 0 });
    } catch (error) {
        return handleError(res, error, "Count incoming requests");
    }
});

// Accept a request that :username sent to me. The request is deleted and the
// friendship inserted in one transaction, with the smaller id first.
router.post(
    "/friend-requests/:username/accept",
    requireAuth,
    async (req, res) => {
        const viewerId = req.session.userId;

        if (viewerId === undefined) {
            return res.status(401).json({ message: "Not authenticated" });
        }

        try {
            const targetId = await findTarget(viewerId, req.params.username);

            await db.transaction(async (tx) => {
                const [accepted] = await tx
                    .delete(friendRequests)
                    .where(
                        and(
                            eq(friendRequests.senderId, targetId),
                            eq(friendRequests.receiverId, viewerId)
                        )
                    )
                    .returning({ id: friendRequests.id });

                if (!accepted) {
                    throw new HttpError(404, "No pending request from this user");
                }

                await tx
                    .insert(friendships)
                    .values({
                        userLowId: Math.min(viewerId, targetId),
                        userHighId: Math.max(viewerId, targetId),
                    })
                    .onConflictDoNothing();
            });

            return res.status(200).json({
                message: "You are now friends",
                relationship: "friend",
            });
        } catch (error) {
            return handleError(res, error, "Accept friend request");
        }
    }
);

// Remove the pending request between me and :username. If I sent it this is a
// cancel, if they sent it this is a decline. Either way the row is just deleted.
router.delete("/friend-requests/:username", requireAuth, async (req, res) => {
    const viewerId = req.session.userId;

    if (viewerId === undefined) {
        return res.status(401).json({ message: "Not authenticated" });
    }

    try {
        const targetId = await findTarget(viewerId, req.params.username);

        const [removed] = await db
            .delete(friendRequests)
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
            .returning({ senderId: friendRequests.senderId });

        if (!removed) {
            throw new HttpError(404, "No pending request with this user");
        }

        return res.status(200).json({
            message:
                removed.senderId === viewerId
                    ? "Friend request cancelled"
                    : "Friend request declined",
            relationship: "none",
        });
    } catch (error) {
        return handleError(res, error, "Remove friend request");
    }
});

/* ------------------------------------------------------------------ */
/* Friends                                                             */
/* ------------------------------------------------------------------ */

// My friends, alphabetical. The row stores the pair in id order, so the
// other person is whichever id is not mine.
router.get("/friends", requireAuth, async (req, res) => {
    const viewerId = req.session.userId;

    if (viewerId === undefined) {
        return res.status(401).json({ message: "Not authenticated" });
    }

    try {
        const rows = await db
            .select({ ...person, since: friendships.createdAt })
            .from(friendships)
            .innerJoin(
                profiles,
                eq(
                    profiles.userId,
                    sql`case when ${friendships.userLowId} = ${viewerId} then ${friendships.userHighId} else ${friendships.userLowId} end`
                )
            )
            .where(
                or(
                    eq(friendships.userLowId, viewerId),
                    eq(friendships.userHighId, viewerId)
                )
            )
            .orderBy(asc(profiles.username));

        return res.status(200).json({ friends: rows.map(toPerson) });
    } catch (error) {
        return handleError(res, error, "List friends");
    }
});

// Remove a friend. Chat history will need a decision here once messages exist.
router.delete("/friends/:username", requireAuth, async (req, res) => {
    const viewerId = req.session.userId;

    if (viewerId === undefined) {
        return res.status(401).json({ message: "Not authenticated" });
    }

    try {
        const targetId = await findTarget(viewerId, req.params.username);

        const [removed] = await db
            .delete(friendships)
            .where(
                and(
                    eq(friendships.userLowId, Math.min(viewerId, targetId)),
                    eq(friendships.userHighId, Math.max(viewerId, targetId))
                )
            )
            .returning({ id: friendships.id });

        if (!removed) {
            throw new HttpError(404, "You are not friends with this user");
        }

        return res.status(200).json({
            message: "Friend removed",
            relationship: "none",
        });
    } catch (error) {
        return handleError(res, error, "Remove friend");
    }
});

export default router;