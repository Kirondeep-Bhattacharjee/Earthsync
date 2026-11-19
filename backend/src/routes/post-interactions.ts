import { Router } from "express";
import rateLimit from "express-rate-limit";
import { and, asc, count, desc, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import { blocks, postComments, postLikes, posts, profiles } from "../db/schema.js";
// Match the import style used in routes/posts.ts (default or named export).
import { requireAuth } from "../middlewares/requireAuth.js";
import { HttpError, handleError, validationError } from "../lib/http.js";
import { requireVisiblePost } from "../lib/post-access.js";
import { isBlockedEitherWay } from "../lib/relationships.js";

const router = Router();

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

// Ids are bigint identities read as JS numbers; 15 digits stays below 2^53.
const idSchema = z
    .string()
    .regex(/^[1-9]\d{0,14}$/)
    .transform(Number);

const listQuerySchema = z.object({
    // Top-level comments page newest first with `before`; replies (`parent`)
    // page oldest first with `after`.
    before: idSchema.optional(),
    after: idSchema.optional(),
    parent: idSchema.optional(),
    limit: z.coerce.number().int().min(1).max(30).default(15),
});

const COMMENT_MAX_LENGTH = 500;

const createCommentSchema = z.object({
    body: z
        .string()
        .trim()
        .min(1, "Write something before posting")
        .max(COMMENT_MAX_LENGTH, `Comments can be up to ${COMMENT_MAX_LENGTH} characters`),
    // Always the id of a top-level comment, or null/absent for a new one.
    parentId: z.number().int().positive().nullable().optional(),
});

/* ------------------------------------------------------------------ */
/* Rate limits                                                         */
/* ------------------------------------------------------------------ */

const likeLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 60,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => String(req.session.userId),
    message: { message: "You are liking too fast. Wait a moment and try again." },
});

const commentLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => String(req.session.userId),
    message: { message: "You have posted many comments. Try again in a while." },
});

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

// Comments from anyone blocked with the viewer (either direction) are left out,
// so a block also works inside someone else's comment section.
function visibleAuthor(viewerId: number) {
    return sql`NOT EXISTS (
        SELECT 1 FROM ${blocks}
        WHERE (${blocks.blockerId} = ${viewerId} AND ${blocks.blockedId} = ${postComments.authorId})
           OR (${blocks.blockerId} = ${postComments.authorId} AND ${blocks.blockedId} = ${viewerId})
    )`;
}

type CommentRow = {
    id: number;
    parentId: number | null;
    body: string;
    createdAt: Date;
    authorId: number;
    username: string;
    pictureKey: string | null;
    replyCount: number;
};

function commentColumns(viewerId: number) {
    return {
        id: postComments.id,
        parentId: postComments.parentId,
        body: postComments.body,
        createdAt: postComments.createdAt,
        authorId: postComments.authorId,
        username: profiles.username,
        pictureKey: profiles.profilePictureKey,
        // Aliased as `r` so the inner table name does not shadow the outer row.
        replyCount: sql<number>`(
            SELECT count(*)::int FROM post_comments r
            WHERE r.parent_id = ${postComments.id}
              AND NOT EXISTS (
                SELECT 1 FROM blocks b
                WHERE (b.blocker_id = ${viewerId} AND b.blocked_id = r.author_id)
                   OR (b.blocker_id = r.author_id AND b.blocked_id = ${viewerId})
              )
        )`,
    };
}

// Replace with the existing avatar URL helper from routes/profile.ts if it is exported.
function pictureUrl(key: string | null): string | null {
    return key ? `${process.env.R2_PUBLIC_URL}/${key}` : null;
}

// The author's user id is never returned; `isMine` and `canDelete` are all the
// client needs.
function toCommentResponse(row: CommentRow, viewerId: number, postAuthorId: number) {
    const isMine = row.authorId === viewerId;

    return {
        id: row.id,
        parentId: row.parentId,
        body: row.body,
        createdAt: row.createdAt.toISOString(),
        replyCount: row.replyCount,
        author: {
            username: row.username,
            profilePictureUrl: pictureUrl(row.pictureKey),
        },
        isMine,
        canDelete: isMine || postAuthorId === viewerId,
    };
}

async function countLikes(postId: number): Promise<number> {
    const [row] = await db
        .select({ total: count() })
        .from(postLikes)
        .where(eq(postLikes.postId, postId));

    return row?.total ?? 0;
}

/* ------------------------------------------------------------------ */
/* Routes: likes                                                       */
/* ------------------------------------------------------------------ */

// Counts and "did I like it" for one post (the viewer calls this when it opens).
router.get("/posts/:id/engagement", requireAuth, async (req, res) => {
    try {
        const postId = idSchema.safeParse(req.params.id);
        if (!postId.success) {
            throw new HttpError(404, "Post not found");
        }

        const userId = req.session.userId!;
        await requireVisiblePost(postId.data, userId);

        const [likeTotal, mine, commentTotal] = await Promise.all([
            countLikes(postId.data),
            db
                .select({ userId: postLikes.userId })
                .from(postLikes)
                .where(and(eq(postLikes.postId, postId.data), eq(postLikes.userId, userId)))
                .limit(1),
            db
                .select({ total: count() })
                .from(postComments)
                .where(and(eq(postComments.postId, postId.data), visibleAuthor(userId))),
        ]);

        return res.json({
            likeCount: likeTotal,
            likedByMe: mine.length > 0,
            commentCount: commentTotal[0]?.total ?? 0,
        });
    } catch (error) {
        return handleError(res, error, "Post engagement");
    }
});

// Idempotent: liking twice leaves one like (the primary key conflicts and the
// insert does nothing). The client sends DELETE to undo.
router.post("/posts/:id/like", requireAuth, likeLimiter, async (req, res) => {
    try {
        const postId = idSchema.safeParse(req.params.id);
        if (!postId.success) {
            throw new HttpError(404, "Post not found");
        }

        const userId = req.session.userId!;
        await requireVisiblePost(postId.data, userId);

        await db
            .insert(postLikes)
            .values({ postId: postId.data, userId })
            .onConflictDoNothing();

        return res.json({ liked: true, likeCount: await countLikes(postId.data) });
    } catch (error) {
        return handleError(res, error, "Like post");
    }
});

// Idempotent too: unliking a post you never liked is not an error. Needs the
// same access as liking (someone who lost access cannot read the count).
router.delete("/posts/:id/like", requireAuth, likeLimiter, async (req, res) => {
    try {
        const postId = idSchema.safeParse(req.params.id);
        if (!postId.success) {
            throw new HttpError(404, "Post not found");
        }

        const userId = req.session.userId!;
        await requireVisiblePost(postId.data, userId);

        await db
            .delete(postLikes)
            .where(and(eq(postLikes.postId, postId.data), eq(postLikes.userId, userId)));

        return res.json({ liked: false, likeCount: await countLikes(postId.data) });
    } catch (error) {
        return handleError(res, error, "Unlike post");
    }
});

/* ------------------------------------------------------------------ */
/* Routes: comments                                                    */
/* ------------------------------------------------------------------ */

// Without `parent`: top-level comments, newest first (`before` cursor).
// With `parent=<comment id>`: that comment's replies, oldest first (`after` cursor).
router.get("/posts/:id/comments", requireAuth, async (req, res) => {
    try {
        const postId = idSchema.safeParse(req.params.id);
        if (!postId.success) {
            throw new HttpError(404, "Post not found");
        }

        const query = listQuerySchema.safeParse(req.query);
        if (!query.success) {
            return validationError(res, query.error);
        }

        const userId = req.session.userId!;
        const post = await requireVisiblePost(postId.data, userId);
        const { before, after, parent, limit } = query.data;

        const where =
            parent === undefined
                ? and(
                      eq(postComments.postId, postId.data),
                      isNull(postComments.parentId),
                      before !== undefined ? lt(postComments.id, before) : undefined,
                      visibleAuthor(userId)
                  )
                : and(
                      eq(postComments.postId, postId.data),
                      eq(postComments.parentId, parent),
                      after !== undefined ? gt(postComments.id, after) : undefined,
                      visibleAuthor(userId)
                  );

        // One extra row tells us whether another page exists.
        const rows = await db
            .select(commentColumns(userId))
            .from(postComments)
            .innerJoin(profiles, eq(profiles.userId, postComments.authorId))
            .where(where)
            .orderBy(parent === undefined ? desc(postComments.id) : asc(postComments.id))
            .limit(limit + 1);

        const hasMore = rows.length > limit;
        const page = hasMore ? rows.slice(0, limit) : rows;
        const last = page[page.length - 1];

        return res.json({
            comments: page.map((row) => toCommentResponse(row, userId, post.authorId)),
            nextCursor: hasMore && last ? last.id : null,
        });
    } catch (error) {
        return handleError(res, error, "List comments");
    }
});

router.post("/posts/:id/comments", requireAuth, commentLimiter, async (req, res) => {
    try {
        const postId = idSchema.safeParse(req.params.id);
        if (!postId.success) {
            throw new HttpError(404, "Post not found");
        }

        const parsed = createCommentSchema.safeParse(req.body);
        if (!parsed.success) {
            return validationError(res, parsed.error);
        }

        const userId = req.session.userId!;
        const post = await requireVisiblePost(postId.data, userId);
        const { body, parentId } = parsed.data;

        if (parentId != null) {
            const [parent] = await db
                .select({ id: postComments.id, parentId: postComments.parentId, authorId: postComments.authorId })
                .from(postComments)
                .where(and(eq(postComments.id, parentId), eq(postComments.postId, postId.data)))
                .limit(1);

            if (!parent) {
                throw new HttpError(404, "Comment not found");
            }

            // One level of replies only: the client always sends the top-level id.
            if (parent.parentId !== null) {
                throw new HttpError(400, "You can only reply to a top-level comment");
            }

            if (await isBlockedEitherWay(userId, parent.authorId)) {
                throw new HttpError(404, "Comment not found");
            }
        }

        const [created] = await db
            .insert(postComments)
            .values({ postId: postId.data, authorId: userId, parentId: parentId ?? null, body })
            .returning({ id: postComments.id, createdAt: postComments.createdAt });

        const [me] = await db
            .select({ username: profiles.username, pictureKey: profiles.profilePictureKey })
            .from(profiles)
            .where(eq(profiles.userId, userId))
            .limit(1);

        if (!created || !me) {
            throw new HttpError(404, "Profile not found");
        }

        return res.status(201).json({
            comment: toCommentResponse(
                {
                    id: created.id,
                    parentId: parentId ?? null,
                    body,
                    createdAt: created.createdAt,
                    authorId: userId,
                    username: me.username,
                    pictureKey: me.pictureKey,
                    replyCount: 0,
                },
                userId,
                post.authorId
            ),
        });
    } catch (error) {
        return handleError(res, error, "Create comment");
    }
});

// The comment's author or the post's author can delete it. Anyone else (and an
// unknown id) gets 404, so the route never confirms that a comment exists.
// `removed` counts the comment plus its replies so the client can fix its total.
router.delete("/comments/:id", requireAuth, async (req, res) => {
    try {
        const commentId = idSchema.safeParse(req.params.id);
        if (!commentId.success) {
            throw new HttpError(404, "Comment not found");
        }

        const userId = req.session.userId!;

        const [comment] = await db
            .select({
                id: postComments.id,
                authorId: postComments.authorId,
                parentId: postComments.parentId,
                postAuthorId: posts.authorId,
            })
            .from(postComments)
            .innerJoin(posts, eq(posts.id, postComments.postId))
            .where(eq(postComments.id, commentId.data))
            .limit(1);

        if (!comment || (comment.authorId !== userId && comment.postAuthorId !== userId)) {
            throw new HttpError(404, "Comment not found");
        }

        let removed = 1;
        if (comment.parentId === null) {
            const [replies] = await db
                .select({ total: count() })
                .from(postComments)
                .where(eq(postComments.parentId, comment.id));
            removed += replies?.total ?? 0;
        }

        await db.delete(postComments).where(eq(postComments.id, comment.id));

        return res.json({ message: "Comment deleted", removed });
    } catch (error) {
        return handleError(res, error, "Delete comment");
    }
});

export default router;