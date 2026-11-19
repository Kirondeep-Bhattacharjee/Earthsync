import { Router } from "express";
import {
    and,
    asc,
    eq,
    inArray,
    like,
    ne,
    notExists,
    or,
    sql,
} from "drizzle-orm";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { db } from "../db/index.js";
import {
    blocks,
    friendRequests,
    friendships,
    profiles,
} from "../db/schema.js";
import { requireAuth } from "../middlewares/requireAuth.js";
import { handleError, validationError } from "../lib/http.js";

const router = Router();

const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL;

const SEARCH_LIMIT = 20;

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

// Lowercases and drops a leading "@" so "@Sam" finds "sam".
const searchQuerySchema = z.object({
    q: z
        .string()
        .trim()
        .toLowerCase()
        .max(100, "Search is too long")
        .transform((value) => value.replace(/^@/, ""))
        .pipe(z.string().min(1, "Enter a username to search")),
});

// A prefix of the username rule. A query that breaks it can never match a username.
const usernameQueryPattern = /^[a-z0-9_]{1,30}$/;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

// Columns read for each result. `userId` is only used to look up the
// relationship and is never sent. No email, no bio: a private profile must
// not leak its bio through search. The username searched and returned is the
// profile's; users.username (the sign-up seed) never appears.
const searchResult = {
    userId: profiles.userId,
    username: profiles.username,
    profilePictureKey: profiles.profilePictureKey,
    visibility: profiles.visibility,
};

// "self" never appears here because the viewer is excluded from the results.
type SearchRelationship =
    | "friend"
    | "request_sent"
    | "request_received"
    | "none";

// Relationship between the viewer and each of the given users, in two queries
// instead of one per result. Anyone missing from the map is "none".
async function getRelationships(
    viewerId: number,
    otherIds: number[]
): Promise<Map<number, SearchRelationship>> {
    const result = new Map<number, SearchRelationship>();

    if (otherIds.length === 0) {
        return result;
    }

    const [friendRows, requestRows] = await Promise.all([
        db
            .select({
                lowId: friendships.userLowId,
                highId: friendships.userHighId,
            })
            .from(friendships)
            .where(
                or(
                    and(
                        eq(friendships.userLowId, viewerId),
                        inArray(friendships.userHighId, otherIds)
                    ),
                    and(
                        eq(friendships.userHighId, viewerId),
                        inArray(friendships.userLowId, otherIds)
                    )
                )
            ),
        db
            .select({
                senderId: friendRequests.senderId,
                receiverId: friendRequests.receiverId,
            })
            .from(friendRequests)
            .where(
                or(
                    and(
                        eq(friendRequests.senderId, viewerId),
                        inArray(friendRequests.receiverId, otherIds)
                    ),
                    and(
                        eq(friendRequests.receiverId, viewerId),
                        inArray(friendRequests.senderId, otherIds)
                    )
                )
            ),
    ]);

    for (const row of requestRows) {
        if (row.senderId === viewerId) {
            result.set(row.receiverId, "request_sent");
        } else {
            result.set(row.senderId, "request_received");
        }
    }

    // A friendship wins if a stale request somehow still exists.
    for (const row of friendRows) {
        result.set(row.lowId === viewerId ? row.highId : row.lowId, "friend");
    }

    return result;
}

// "_" is a wildcard in LIKE and is allowed in usernames, so escape it
// (and "%" and "\" for safety) to get a true prefix match.
function escapeLike(value: string): string {
    return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

// Per user, not per IP. Typing fires several requests, so the limit is generous.
const searchLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 60,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => String(req.session.userId ?? "anonymous"),
    message: { message: "Too many searches. Try again in a minute." },
});

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

// Username prefix search. Public and private profiles both appear.
// Excluded: the viewer, and anyone blocked in either direction.
// Each result carries the viewer's `relationship` to that person, so the
// Connect page can show the right button without a request per row.
router.get("/users/search", requireAuth, searchLimiter, async (req, res) => {
    const viewerId = req.session.userId;

    if (viewerId === undefined) {
        return res.status(401).json({ message: "Not authenticated" });
    }

    const parsed = searchQuerySchema.safeParse(req.query);

    if (!parsed.success) {
        return validationError(res, parsed.error);
    }

    const query = parsed.data.q;

    if (!usernameQueryPattern.test(query)) {
        return res.status(200).json({ users: [] });
    }

    try {
        const rows = await db
            .select(searchResult)
            .from(profiles)
            .where(
                and(
                    like(profiles.username, `${escapeLike(query)}%`),
                    ne(profiles.userId, viewerId),
                    // A block in either direction hides the two users from each other.
                    notExists(
                        db
                            .select({ one: sql`1` })
                            .from(blocks)
                            .where(
                                or(
                                    and(
                                        eq(blocks.blockerId, viewerId),
                                        eq(blocks.blockedId, profiles.userId)
                                    ),
                                    and(
                                        eq(blocks.blockerId, profiles.userId),
                                        eq(blocks.blockedId, viewerId)
                                    )
                                )
                            )
                    )
                )
            )
            .orderBy(asc(profiles.username))
            .limit(SEARCH_LIMIT);

        const relationships = await getRelationships(
            viewerId,
            rows.map((row) => row.userId)
        );

        return res.status(200).json({
            users: rows.map((row) => ({
                username: row.username,
                visibility: row.visibility,
                profilePictureUrl:
                    row.profilePictureKey && R2_PUBLIC_URL
                        ? `${R2_PUBLIC_URL}/${row.profilePictureKey}`
                        : null,
                relationship: relationships.get(row.userId) ?? "none",
            })),
        });
    } catch (error) {
        return handleError(res, error, "Search users");
    }
});

export default router;