import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import multer from "multer";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { db } from "../db/index.js";
import { media, posts, profiles } from "../db/schema.js";
import { requireAuth } from "../middlewares/requireAuth.js";
import { HttpError, handleError, validationError } from "../lib/http.js";
import { VIDEO_MAX_BYTES, processUpload } from "../lib/post-media.js";
import {
    createPostKeys,
    deletePostObjects,
    putPostObject,
    signPostUrl,
} from "../lib/r2.js";
import {
    canViewFullProfile,
    getRelationship,
    isBlockedEitherWay,
} from "../lib/relationships.js";
import { usernameSchema } from "../lib/username.js";

const router = Router();

const PAGE_SIZE_DEFAULT = 12;
const PAGE_SIZE_MAX = 30;

// Columns the API needs to describe a post. Never includes the author's id.
const postColumns = {
    id: posts.id,
    caption: posts.caption,
    createdAt: posts.createdAt,
    type: sql<"image" | "video">`${media.type}`,
    key: media.key,
    thumbKey: media.thumbKey,
    width: media.width,
    height: media.height,
    durationSeconds: media.durationSeconds,
};

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

// Trims, and turns "" into null. The caption arrives as a multipart text
// field, so it is a string or missing.
const createPostSchema = z.object({
    caption: z
        .string()
        .trim()
        .max(500, "Caption must be at most 500 characters")
        .transform((value) => (value === "" ? null : value))
        .optional(),
});

const listQuerySchema = z.object({
    before: z.coerce.number().int().positive().optional(),
    limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(PAGE_SIZE_MAX)
        .default(PAGE_SIZE_DEFAULT),
});

const postIdSchema = z.coerce.number().int().positive();

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

type PostRow = {
    id: number;
    caption: string | null;
    createdAt: Date;
    type: "image" | "video";
    key: string;
    thumbKey: string | null;
    width: number | null;
    height: number | null;
    durationSeconds: number | null;
};

// Signed URLs are made here, after the route has decided the viewer may see
// the post. They expire after an hour.
async function toPostResponse(row: PostRow) {
    const [url, thumbUrl] = await Promise.all([
        signPostUrl(row.key),
        row.thumbKey ? signPostUrl(row.thumbKey) : Promise.resolve(null),
    ]);

    return {
        id: row.id,
        caption: row.caption,
        createdAt: row.createdAt.toISOString(),
        media: {
            type: row.type,
            url,
            thumbUrl,
            width: row.width,
            height: row.height,
            durationSeconds: row.durationSeconds,
        },
    };
}

// Videos are written to disk, not memory: a 100 MB upload would otherwise sit
// in RAM for every request in flight.
const upload = multer({
    storage: multer.diskStorage({ destination: tmpdir() }),
    limits: { fileSize: VIDEO_MAX_BYTES, files: 1 },
});

// Runs multer and turns its errors into the same JSON shape as the rest of the API.
function receiveMedia(req: Request, res: Response, next: NextFunction) {
    upload.single("media")(req, res, (error: unknown) => {
        if (!error) {
            next();
            return;
        }

        if (error instanceof multer.MulterError) {
            if (error.code === "LIMIT_FILE_SIZE") {
                res.status(413).json({
                    message: "Files must be 100 MB or smaller",
                });
                return;
            }

            res.status(400).json({ message: "Invalid upload" });
            return;
        }

        handleError(res, error, "Post upload");
    });
}

// Per user, not per IP, and only on the expensive route.
const createPostLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => String(req.session.userId ?? "anonymous"),
    message: { message: "Too many posts. Try again later." },
});

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

// Create a post: multipart form with the file in "media" and an optional
// "caption". The file is checked and re-encoded here (photos to WebP, videos
// to a 720p MP4 of at most 30 seconds), so what is stored is never the
// original upload.
router.post(
    "/posts",
    requireAuth,
    createPostLimiter,
    receiveMedia,
    async (req, res) => {
        const userId = req.session.userId;
        const file = req.file;

        try {
            if (userId === undefined) {
                return res.status(401).json({ message: "Not authenticated" });
            }

            const parsed = createPostSchema.safeParse(req.body ?? {});

            if (!parsed.success) {
                return validationError(res, parsed.error);
            }

            if (!file) {
                return res
                    .status(400)
                    .json({ message: "Choose a photo or video to post" });
            }

            const processed = await processUpload(file);
            const { key, thumbKey } = createPostKeys(userId, processed.type);
            const caption = parsed.data.caption ?? null;

            let created: { id: number; createdAt: Date };

            try {
                // Upload first: if this fails, nothing in the database changed.
                await Promise.all([
                    putPostObject(key, processed.body, processed.contentType),
                    putPostObject(thumbKey, processed.thumb, "image/webp"),
                ]);

                created = await db.transaction(async (tx) => {
                    const [mediaRow] = await tx
                        .insert(media)
                        .values({
                            userId,
                            key,
                            thumbKey,
                            type: processed.type,
                            contentType: processed.contentType,
                            sizeBytes: processed.body.length,
                            durationSeconds: processed.durationSeconds,
                            width: processed.width,
                            height: processed.height,
                            status: "ready",
                        })
                        .returning({ id: media.id });

                    if (!mediaRow) {
                        throw new Error("Media insert returned no row");
                    }

                    const [postRow] = await tx
                        .insert(posts)
                        .values({
                            authorId: userId,
                            mediaId: mediaRow.id,
                            caption,
                        })
                        .returning({
                            id: posts.id,
                            createdAt: posts.createdAt,
                        });

                    if (!postRow) {
                        throw new Error("Post insert returned no row");
                    }

                    return postRow;
                });
            } catch (error) {
                // The files are unused now, so don't leave them behind.
                await deletePostObjects([key, thumbKey]);
                throw error;
            }

            const post = await toPostResponse({
                id: created.id,
                caption,
                createdAt: created.createdAt,
                type: processed.type,
                key,
                thumbKey,
                width: processed.width,
                height: processed.height,
                durationSeconds: processed.durationSeconds,
            });

            return res.status(201).json({ post });
        } catch (error) {
            return handleError(res, error, "Create post");
        } finally {
            // multer wrote the upload to disk; it is never needed after this.
            if (file) {
                await rm(file.path, { force: true });
            }
        }
    }
);

// One page of a user's posts, newest first. Page with `before=<post id>`:
// pass the previous response's nextCursor until it is null.
//
// Same visibility rule as the profile route:
// - Blocked in either direction, or an unknown username: 404, so a block
//   never reveals that the account exists.
// - Private profile and not a friend: 403. The check lives here, not only in
//   the UI, so a hand-made request gets nothing either.
router.get("/profile/:username/posts", requireAuth, async (req, res) => {
    const viewerId = req.session.userId;

    if (viewerId === undefined) {
        return res.status(401).json({ message: "Not authenticated" });
    }

    // A malformed username can never exist, so it is a 404.
    const username = usernameSchema.safeParse(req.params.username);

    if (!username.success) {
        return res.status(404).json({ message: "User not found" });
    }

    const query = listQuerySchema.safeParse(req.query);

    if (!query.success) {
        return validationError(res, query.error);
    }

    try {
        const [target] = await db
            .select({ id: profiles.userId, visibility: profiles.visibility })
            .from(profiles)
            .where(eq(profiles.username, username.data))
            .limit(1);

        if (!target) {
            return res.status(404).json({ message: "User not found" });
        }

        const [blocked, relationship] = await Promise.all([
            isBlockedEitherWay(viewerId, target.id),
            getRelationship(viewerId, target.id),
        ]);

        if (blocked) {
            return res.status(404).json({ message: "User not found" });
        }

        if (!canViewFullProfile(target.visibility, relationship)) {
            return res
                .status(403)
                .json({ message: "Posts are only visible to friends" });
        }

        const { before, limit } = query.data;

        // One extra row tells us whether another page exists.
        const rows = await db
            .select(postColumns)
            .from(posts)
            .innerJoin(media, eq(posts.mediaId, media.id))
            .where(
                and(
                    eq(posts.authorId, target.id),
                    before !== undefined ? lt(posts.id, before) : undefined
                )
            )
            .orderBy(desc(posts.id))
            .limit(limit + 1);

        const page = rows.slice(0, limit);
        const last = page[page.length - 1];

        return res.status(200).json({
            posts: await Promise.all(page.map((row) => toPostResponse(row))),
            nextCursor: rows.length > limit && last ? last.id : null,
        });
    } catch (error) {
        return handleError(res, error, "List posts");
    }
});

// Delete one of my own posts. Someone else's post is a 404, not a 403, so the
// route never confirms that a post id exists.
router.delete("/posts/:id", requireAuth, async (req, res) => {
    const userId = req.session.userId;

    if (userId === undefined) {
        return res.status(401).json({ message: "Not authenticated" });
    }

    const id = postIdSchema.safeParse(req.params.id);

    if (!id.success) {
        return res.status(404).json({ message: "Post not found" });
    }

    try {
        const [existing] = await db
            .select({
                mediaId: posts.mediaId,
                key: media.key,
                thumbKey: media.thumbKey,
            })
            .from(posts)
            .innerJoin(media, eq(posts.mediaId, media.id))
            .where(and(eq(posts.id, id.data), eq(posts.authorId, userId)))
            .limit(1);

        if (!existing) {
            throw new HttpError(404, "Post not found");
        }

        // Database first, so the app never points at a file that is gone.
        // Deleting the media row removes the post with it (cascade).
        await db.delete(media).where(eq(media.id, existing.mediaId));

        await deletePostObjects(
            existing.thumbKey ? [existing.key, existing.thumbKey] : [existing.key]
        );

        return res.status(200).json({ message: "Post deleted" });
    } catch (error) {
        return handleError(res, error, "Delete post");
    }
});

export default router;
