import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import { eq } from "drizzle-orm";
import multer from "multer";
import sharp from "sharp";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { db } from "../db/index.js";
import { profiles } from "../db/schema.js";
import { requireAuth } from "../middlewares/requireAuth.js";
import {
    HttpError,
    handleError,
    uniqueViolation,
    validationError,
} from "../lib/http.js";
import { createAvatarKey, deleteAvatar, putAvatar } from "../lib/r2.js";
import { getRelationship, isBlockedEitherWay } from "../lib/relationships.js";
import { usernameSchema } from "../lib/username.js";

const router = Router();

const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL;

const AVATAR_MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const AVATAR_SIZE = 512; // stored as a 512x512 square
// Rejects decompression bombs: a tiny file that expands to a huge bitmap.
const AVATAR_MAX_INPUT_PIXELS = 50_000_000;

// Columns that are safe to send to the client.
const publicProfile = {
    username: profiles.username,
    bio: profiles.bio,
    profilePictureKey: profiles.profilePictureKey,
    visibility: profiles.visibility,
};

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

// Trims, turns "" into null (so the user can clear a field), and leaves
// the field untouched when it is missing from the request.
function optionalText(max: number, label: string) {
    return z
        .string()
        .trim()
        .max(max, `${label} must be at most ${max} characters`)
        .transform((value) => (value === "" ? null : value))
        .nullable()
        .optional();
}

// Unknown keys are stripped, so a client can never set profilePictureKey
// through this route. That is only done by the avatar routes below.
const updateProfileSchema = z
    .object({
        username: usernameSchema.optional(),
        bio: optionalText(500, "Bio"),
        visibility: z.enum(["public", "private"]).optional(),
    })
    .refine(
        (data) => Object.values(data).some((value) => value !== undefined),
        { message: "Provide at least one field to update" }
    );

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

type ProfileRow = {
    username: string;
    bio: string | null;
    profilePictureKey: string | null;
    visibility: "public" | "private";
};

function toResponse(profile: ProfileRow) {
    return {
        username: profile.username,
        bio: profile.bio,
        visibility: profile.visibility,
        profilePictureUrl:
            profile.profilePictureKey && R2_PUBLIC_URL
                ? `${R2_PUBLIC_URL}/${profile.profilePictureKey}`
                : null,
    };
}

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: AVATAR_MAX_BYTES, files: 1 },
});

// Runs multer and turns its errors into the same JSON shape as the rest of the API.
function receiveAvatar(req: Request, res: Response, next: NextFunction) {
    upload.single("avatar")(req, res, (error: unknown) => {
        if (!error) {
            next();
            return;
        }

        if (error instanceof multer.MulterError) {
            if (error.code === "LIMIT_FILE_SIZE") {
                res.status(413).json({ message: "Image must be 5 MB or smaller" });
                return;
            }

            res.status(400).json({ message: "Invalid upload" });
            return;
        }

        handleError(res, error, "Avatar upload");
    });
}

// Decodes the file (so non-images fail here, whatever the client claimed),
// applies the EXIF rotation, crops to a square and re-encodes as WebP.
// sharp drops all metadata (including GPS location) unless asked to keep it.
async function processAvatar(input: Buffer): Promise<Buffer> {
    try {
        return await sharp(input, { limitInputPixels: AVATAR_MAX_INPUT_PIXELS })
            .rotate()
            .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: "cover" })
            .webp({ quality: 82 })
            .toBuffer();
    } catch {
        throw new HttpError(400, "That file isn't a valid image");
    }
}

// Per user, not per IP, and only on the expensive route.
const avatarUploadLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => String(req.session.userId ?? "anonymous"),
    message: { message: "Too many uploads. Try again in a few minutes." },
});

// Renaming breaks old profile links, so keep it slow. Edits that don't touch
// the username (bio, visibility) skip the limit.
const usernameChangeLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 5,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => String(req.session.userId ?? "anonymous"),
    skip: (req) =>
        (req.body as { username?: unknown } | undefined)?.username === undefined,
    message: { message: "Too many username changes. Try again later." },
});

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

// Every account gets a profile row at sign-up, so a missing row is a 404.
router.get("/profile", requireAuth, async (req, res) => {
    const userId = req.session.userId;

    if (userId === undefined) {
        return res.status(401).json({ message: "Not authenticated" });
    }

    try {
        const [profile] = await db
            .select(publicProfile)
            .from(profiles)
            .where(eq(profiles.userId, userId))
            .limit(1);

        if (!profile) {
            throw new HttpError(404, "Profile not found");
        }

        return res.status(200).json({ profile: toResponse(profile) });
    } catch (error) {
        return handleError(res, error, "Get profile");
    }
});

// Partial update. The username is the public handle that search and profile
// links use; it must stay unique, so a taken name is a 409 on that field.
router.put(
    "/profile",
    requireAuth,
    usernameChangeLimiter,
    async (req, res) => {
        const userId = req.session.userId;

        if (userId === undefined) {
            return res.status(401).json({ message: "Not authenticated" });
        }

        const parsed = updateProfileSchema.safeParse(req.body);

        if (!parsed.success) {
            return validationError(res, parsed.error);
        }

        const updates = parsed.data;

        try {
            const [profile] = await db
                .update(profiles)
                .set({ ...updates, updatedAt: new Date() })
                .where(eq(profiles.userId, userId))
                .returning(publicProfile);

            if (!profile) {
                throw new HttpError(404, "Profile not found");
            }

            return res.status(200).json({
                message: "Profile updated",
                profile: toResponse(profile),
            });
        } catch (error) {
            // The username is the only unique column an update can touch.
            if (uniqueViolation(error)) {
                return res.status(409).json({
                    message: "That username is taken",
                    errors: [
                        { field: "username", message: "That username is taken" },
                    ],
                });
            }

            return handleError(res, error, "Update profile");
        }
    }
);

// View another user's profile.
// - Blocked in either direction: 404, so a block never reveals that the account exists.
// - Public profile, or a friend, or yourself: full profile.
// - Private profile and not a friend: header only (name, picture), bio hidden.
//   Later, posts and feeds follow the same canViewFullProfile flag.
router.get("/profile/:username", requireAuth, async (req, res) => {
    const viewerId = req.session.userId;

    if (viewerId === undefined) {
        return res.status(401).json({ message: "Not authenticated" });
    }

    // A malformed username can never exist, so it is a 404.
    const username = usernameSchema.safeParse(req.params.username);

    if (!username.success) {
        return res.status(404).json({ message: "User not found" });
    }

    try {
        const [target] = await db
            .select({ id: profiles.userId, ...publicProfile })
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

        const canViewFullProfile =
            target.visibility === "public" ||
            relationship === "friend" ||
            relationship === "self";

        const profile = toResponse(target);

        return res.status(200).json({
            user: {
                ...profile,
                bio: canViewFullProfile ? profile.bio : null,
            },
            relationship,
            canViewFullProfile,
        });
    } catch (error) {
        return handleError(res, error, "Get user profile");
    }
});

// Upload or replace the profile picture (multipart form, field name "avatar").
router.post(
    "/profile/avatar",
    requireAuth,
    avatarUploadLimiter,
    receiveAvatar,
    async (req, res) => {
        const userId = req.session.userId;

        if (userId === undefined) {
            return res.status(401).json({ message: "Not authenticated" });
        }

        if (!req.file) {
            return res.status(400).json({ message: "Choose an image to upload" });
        }

        try {
            const processed = await processAvatar(req.file.buffer);
            const newKey = createAvatarKey();

            // Upload first: if this fails, nothing in the database has changed.
            await putAvatar(newKey, processed);

            let previousKey: string | null = null;
            let profile;

            try {
                const [previous] = await db
                    .select({ key: profiles.profilePictureKey })
                    .from(profiles)
                    .where(eq(profiles.userId, userId))
                    .limit(1);

                if (!previous) {
                    throw new HttpError(404, "Profile not found");
                }

                previousKey = previous.key;

                [profile] = await db
                    .update(profiles)
                    .set({ profilePictureKey: newKey, updatedAt: new Date() })
                    .where(eq(profiles.userId, userId))
                    .returning(publicProfile);

                if (!profile) {
                    throw new Error("Avatar update returned no row");
                }
            } catch (dbError) {
                // The new file is unused now, so don't leave it behind.
                await deleteAvatar(newKey);
                throw dbError;
            }

            // Database now points at the new file: the old one can go.
            if (previousKey) {
                await deleteAvatar(previousKey);
            }

            return res.status(200).json({
                message: "Profile picture updated",
                profile: toResponse(profile),
            });
        } catch (error) {
            return handleError(res, error, "Upload avatar");
        }
    }
);

// Remove the profile picture. Safe to call when there is none.
router.delete("/profile/avatar", requireAuth, async (req, res) => {
    const userId = req.session.userId;

    if (userId === undefined) {
        return res.status(401).json({ message: "Not authenticated" });
    }

    try {
        const [existing] = await db
            .select(publicProfile)
            .from(profiles)
            .where(eq(profiles.userId, userId))
            .limit(1);

        if (!existing) {
            throw new HttpError(404, "Profile not found");
        }

        if (!existing.profilePictureKey) {
            return res.status(200).json({
                message: "No profile picture to remove",
                profile: toResponse(existing),
            });
        }

        // Database first, so the app never points at a file that is gone.
        const [profile] = await db
            .update(profiles)
            .set({ profilePictureKey: null, updatedAt: new Date() })
            .where(eq(profiles.userId, userId))
            .returning(publicProfile);

        if (!profile) {
            throw new HttpError(404, "Profile not found");
        }

        await deleteAvatar(existing.profilePictureKey);

        return res.status(200).json({
            message: "Profile picture removed",
            profile: toResponse(profile),
        });
    } catch (error) {
        return handleError(res, error, "Remove avatar");
    }
});

export default router;