import { Router } from "express";
import type { Request } from "express";
import { eq } from "drizzle-orm";
import bcrypt from "bcrypt";
import { OAuth2Client } from "google-auth-library";
import { z } from "zod";
import { db } from "../db/index.js";
import { profiles, users } from "../db/schema.js";
import { requireAuth } from "../middlewares/requireAuth.js";
import {
    HttpError,
    handleError,
    uniqueViolation,
    validationError,
} from "../lib/http.js";
import { generateUsername, usernameSchema } from "../lib/username.js";

const router = Router();

// Must match the `name` option in your express-session config (default is "connect.sid").
const SESSION_COOKIE_NAME = "sync.sid";
const BCRYPT_ROUNDS = 12;

const googleClientId = process.env.GOOGLE_CLIENT_ID;
const googleClient = new OAuth2Client(googleClientId);

// Compared against when an account doesn't exist, so sign-in takes about the
// same time whether or not the username/email is registered.
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", BCRYPT_ROUNDS);

// Columns that are safe to send to the client (never include passwordHash).
// The username is the profile's: users.username is only the sign-up seed.
const publicUser = {
    id: users.id,
    username: profiles.username,
    email: users.email,
};

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

const signUpSchema = z.object({
    username: usernameSchema,
    email: z
        .string()
        .trim()
        .toLowerCase()
        .max(255, "Email is too long")
        .email("Enter a valid email address"),
    password: z
        .string()
        .min(8, "Password must be at least 8 characters")
        .max(72, "Password must be at most 72 characters"),
});

const signInSchema = z.object({
    identifier: z
        .string()
        .trim()
        .toLowerCase()
        .min(1, "Enter your username or email"),
    password: z.string().min(1, "Enter your password"),
});

const googleSchema = z.object({
    credential: z.string().min(1, "Missing Google credential"),
});

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

// Replaces the session ID on login (prevents session fixation), then stores the user.
function startSession(req: Request, userId: number): Promise<void> {
    return new Promise((resolve, reject) => {
        req.session.regenerate((regenerateError) => {
            if (regenerateError) {
                reject(regenerateError);
                return;
            }

            req.session.userId = userId;

            req.session.save((saveError) => {
                if (saveError) {
                    reject(saveError);
                    return;
                }

                resolve();
            });
        });
    });
}

function fieldFromConstraint(constraint: string) {
    if (constraint.includes("username")) return "username";
    if (constraint.includes("email")) return "email";
    if (constraint.includes("google")) return "googleId";
    return "unknown";
}

function selectPublicUser() {
    return db
        .select(publicUser)
        .from(users)
        .innerJoin(profiles, eq(profiles.userId, users.id));
}

async function getPublicUser(userId: number) {
    const [user] = await selectPublicUser()
        .where(eq(users.id, userId))
        .limit(1);

    return user;
}

// Creates the account and its profile together, so every user always has a
// profile row. users.username is only the seed: from here on the name lives in
// profiles.username, which is what search, profile links and the UI use.
async function createUserWithProfile(values: {
    username: string;
    email: string;
    passwordHash?: string | null;
    googleId?: string | null;
    emailVerified?: boolean;
}): Promise<number> {
    return db.transaction(async (tx) => {
        const [created] = await tx
            .insert(users)
            .values(values)
            .returning({ id: users.id });

        if (!created) {
            throw new Error("Insert returned no row");
        }

        await tx
            .insert(profiles)
            .values({ userId: created.id, username: values.username });

        return created.id;
    });
}

/* ------------------------------------------------------------------ */
/* Google helpers                                                      */
/* ------------------------------------------------------------------ */

async function verifyGoogleCredential(credential: string) {
    let payload;

    try {
        const ticket = await googleClient.verifyIdToken({
            idToken: credential,
            audience: googleClientId,
        });
        payload = ticket.getPayload();
    } catch {
        throw new HttpError(401, "Invalid Google credential");
    }

    if (!payload?.sub || !payload.email) {
        throw new HttpError(401, "Google account has no email address");
    }

    // Never trust an unverified email: it could be used to take over an existing account.
    if (!payload.email_verified) {
        throw new HttpError(403, "Your Google email address is not verified");
    }

    return {
        googleId: payload.sub,
        email: payload.email.toLowerCase(),
    };
}

async function findOrCreateGoogleUser(googleId: string, email: string) {
    // 1. This Google account is already linked: just log in.
    const [linked] = await selectPublicUser()
        .where(eq(users.googleId, googleId))
        .limit(1);

    if (linked) {
        return { user: linked, isNewUser: false };
    }

    // 2. A user with this (Google-verified) email exists: link the accounts.
    const [existing] = await db
        .select()
        .from(users)
        .where(eq(users.email, email))
        .limit(1);

    if (existing) {
        if (existing.googleId && existing.googleId !== googleId) {
            throw new HttpError(
                409,
                "This email is already linked to a different Google account"
            );
        }

        await db
            .update(users)
            .set({
                googleId,
                emailVerified: true,
                // The password on an unverified account was set by someone who never
                // proved they own this email, so drop it. The real owner just proved
                // it via Google and can set a new password later.
                ...(existing.emailVerified ? {} : { passwordHash: null }),
            })
            .where(eq(users.id, existing.id));

        const updated = await getPublicUser(existing.id);

        if (!updated) {
            throw new Error("Failed to link Google account");
        }

        return { user: updated, isNewUser: false };
    }

    // 3. Brand new user: create it with a random username (never derived from
    // the email or the Google name). They can rename themselves from their profile.
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            const userId = await createUserWithProfile({
                username: generateUsername(),
                email,
                googleId,
                emailVerified: true,
            });

            const created = await getPublicUser(userId);

            if (created) {
                return { user: created, isNewUser: true };
            }
        } catch (error) {
            const constraint = uniqueViolation(error);

            if (!constraint) {
                throw error;
            }

            if (fieldFromConstraint(constraint) === "username") {
                continue; // generated name collided: try another
            }

            // Email/googleId collision means a parallel request created this user first.
            const [raced] = await selectPublicUser()
                .where(eq(users.googleId, googleId))
                .limit(1);

            if (raced) {
                return { user: raced, isNewUser: false };
            }

            throw error;
        }
    }

    throw new HttpError(500, "Could not generate a unique username");
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

router.post("/auth/sign-up", async (req, res) => {
    const parsed = signUpSchema.safeParse(req.body);

    if (!parsed.success) {
        return validationError(res, parsed.error);
    }

    const { username, email, password } = parsed.data;

    try {
        const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

        const userId = await createUserWithProfile({
            username,
            email,
            passwordHash,
        });

        const user = await getPublicUser(userId);

        if (!user) {
            throw new Error("Created user could not be loaded");
        }

        await startSession(req, user.id);

        return res.status(201).json({ message: "Account created", user });
    } catch (error) {
        const constraint = uniqueViolation(error);

        if (constraint) {
            const field = fieldFromConstraint(constraint);
            const message =
                field === "email"
                    ? "That email is already registered"
                    : field === "username"
                      ? "That username is taken"
                      : "An account with these details already exists";

            return res.status(409).json({ message, field });
        }

        return handleError(res, error, "Sign-up");
    }
});

router.post("/auth/sign-in", async (req, res) => {
    const parsed = signInSchema.safeParse(req.body);

    if (!parsed.success) {
        return validationError(res, parsed.error);
    }

    const { identifier, password } = parsed.data;

    try {
        // Accept either a username (the profile's) or an email in the same field.
        const [user] = await db
            .select({
                id: users.id,
                username: profiles.username,
                email: users.email,
                passwordHash: users.passwordHash,
            })
            .from(users)
            .innerJoin(profiles, eq(profiles.userId, users.id))
            .where(
                identifier.includes("@")
                    ? eq(users.email, identifier)
                    : eq(profiles.username, identifier)
            )
            .limit(1);

        if (!user) {
            await bcrypt.compare(password, DUMMY_HASH);
            return res
                .status(401)
                .json({ message: "Invalid username or password" });
        }

        // Google-only accounts have no password to check.
        if (!user.passwordHash) {
            return res.status(401).json({
                message:
                    "This account uses Google sign-in. Continue with Google instead.",
            });
        }

        const passwordMatches = await bcrypt.compare(
            password,
            user.passwordHash
        );

        if (!passwordMatches) {
            return res
                .status(401)
                .json({ message: "Invalid username or password" });
        }

        await startSession(req, user.id);

        return res.status(200).json({
            message: "Login successful",
            user: { id: user.id, username: user.username, email: user.email },
        });
    } catch (error) {
        return handleError(res, error, "Sign-in");
    }
});

// Frontend sends the ID token ("credential") from Google Identity Services here.
router.post("/auth/google", async (req, res) => {
    if (!googleClientId) {
        console.error("GOOGLE_CLIENT_ID is not configured");
        return res
            .status(503)
            .json({ message: "Google sign-in is not available" });
    }

    const parsed = googleSchema.safeParse(req.body);

    if (!parsed.success) {
        return validationError(res, parsed.error);
    }

    try {
        const { googleId, email } = await verifyGoogleCredential(
            parsed.data.credential
        );

        const { user, isNewUser } = await findOrCreateGoogleUser(
            googleId,
            email
        );

        await startSession(req, user.id);

        return res.status(isNewUser ? 201 : 200).json({
            message: isNewUser ? "Account created" : "Login successful",
            isNewUser,
            user,
        });
    } catch (error) {
        return handleError(res, error, "Google sign-in");
    }
});

// POST (not GET) so other sites can't sign users out with an <img> tag.
router.post("/auth/sign-out", (req, res) => {
    req.session.destroy((error) => {
        if (error) {
            console.error("Sign-out error:", error);
            return res.status(500).json({ message: "Could not sign out" });
        }

        res.clearCookie(SESSION_COOKIE_NAME);
        return res.status(200).json({ message: "Signed out" });
    });
});

router.get("/auth/me", requireAuth, async (req, res) => {
    const userId = req.session.userId;

    if (userId === undefined) {
        return res.status(401).json({ authenticated: false });
    }

    try {
        const user = await getPublicUser(userId);

        // Session points at a user that no longer exists: clear it.
        if (!user) {
            req.session.destroy(() => {
                res.clearCookie(SESSION_COOKIE_NAME);
                res.status(401).json({ authenticated: false });
            });
            return;
        }

        return res.status(200).json({ authenticated: true, user });
    } catch (error) {
        return handleError(res, error, "Session check");
    }
});

export default router;