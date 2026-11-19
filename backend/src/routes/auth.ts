import { Router } from "express";
import type { Request, Response } from "express";
import { eq } from "drizzle-orm";
import bcrypt from "bcrypt";
import { OAuth2Client } from "google-auth-library";
import { z } from "zod";
import { db } from "../db/index.js";
import { accountPrivate, consents, profiles, users } from "../db/schema.js";
import { requireAuth } from "../middlewares/requireAuth.js";
import {
    HttpError,
    handleError,
    uniqueViolation,
    validationError,
} from "../lib/http.js";
import { usernameSchema } from "../lib/username.js";
import { dobSchema, isAdult } from "../lib/dob.js";
import { consentFieldsSchema, consentRowsFor } from "../lib/consent.js";
import { consentKey, getOnboardingStatus } from "../lib/onboarding.js";

const router = Router();

// Must match the `name` option in your express-session config (default is "connect.sid").
const SESSION_COOKIE_NAME = "sync.sid";
const BCRYPT_ROUNDS = 12;

// How long a verified Google identity may wait for the onboarding form.
const PENDING_GOOGLE_MS = 15 * 60 * 1000;

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

const signUpSchema = z
    .object({
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
        dateOfBirth: dobSchema,
    })
    .extend(consentFieldsSchema.shape);

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

// Onboarding form. username and dateOfBirth are optional here because which of
// them is needed depends on the session (new Google user, existing account
// without a date of birth, or an account that only needs to re-accept).
const completeOnboardingSchema = z
    .object({
        username: usernameSchema.optional(),
        dateOfBirth: dobSchema.optional(),
    })
    .extend(consentFieldsSchema.shape);

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

// Google proved who this is, but no account exists yet. The identity is kept in
// the server-side session only (never trusted from the client later), and no
// userId is set, so requireAuth still treats the browser as signed out.
function startPendingGoogleSession(
    req: Request,
    identity: { googleId: string; email: string }
): Promise<void> {
    return new Promise((resolve, reject) => {
        req.session.regenerate((regenerateError) => {
            if (regenerateError) {
                reject(regenerateError);
                return;
            }

            req.session.pendingGoogle = {
                ...identity,
                expiresAt: Date.now() + PENDING_GOOGLE_MS,
            };

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

function getPendingGoogle(req: Request) {
    const pending = req.session.pendingGoogle;

    if (!pending) {
        return null;
    }

    if (pending.expiresAt < Date.now()) {
        delete req.session.pendingGoogle;
        return null;
    }

    return pending;
}

function destroySession(req: Request, res: Response): Promise<void> {
    return new Promise((resolve) => {
        req.session.destroy(() => {
            res.clearCookie(SESSION_COOKIE_NAME);
            resolve();
        });
    });
}

function fieldError(res: Response, field: string, message: string) {
    return res.status(400).json({
        message: "Invalid input",
        errors: [{ field, message }],
    });
}

function underAge(res: Response) {
    return res.status(403).json({
        message: "You must be 18 or older to create an account",
        code: "UNDER_AGE",
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
//
// When `onboarding` is given, the date of birth and the consents are written in
// the same transaction, so an account can never exist half-onboarded. Both
// sign-up paths (password and Google) pass it.
async function createUserWithProfile(
    values: {
        username: string;
        email: string;
        passwordHash?: string | null;
        googleId?: string | null;
        emailVerified?: boolean;
    },
    onboarding?: { dateOfBirth: string }
): Promise<number> {
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

        if (onboarding) {
            await tx.insert(accountPrivate).values({
                userId: created.id,
                dateOfBirth: onboarding.dateOfBirth,
            });

            await tx.insert(consents).values(consentRowsFor(created.id));
        }

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

// Finds the account for a verified Google identity, or returns null when there
// is none. It never creates one: new Google users are created only after they
// complete onboarding (date of birth and consents).
async function findGoogleUser(googleId: string, email: string) {
    // 1. This Google account is already linked: just log in.
    const [linked] = await selectPublicUser()
        .where(eq(users.googleId, googleId))
        .limit(1);

    if (linked) {
        return linked;
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

        return updated;
    }

    // 3. Nobody yet: the caller sends the browser to onboarding.
    return null;
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

router.post("/auth/sign-up", async (req, res) => {
    const parsed = signUpSchema.safeParse(req.body);

    if (!parsed.success) {
        return validationError(res, parsed.error);
    }

    const { username, email, password, dateOfBirth } = parsed.data;

    // Checked before hashing the password and before anything is written, so an
    // under-18 attempt leaves no user, profile or date of birth behind.
    if (!isAdult(dateOfBirth)) {
        return underAge(res);
    }

    try {
        const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

        const userId = await createUserWithProfile(
            {
                username,
                email,
                passwordHash,
            },
            { dateOfBirth }
        );

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

        // Accounts created before onboarding existed are signed in but gated
        // until they finish it; the client sends them to /onboarding.
        const onboarding = await getOnboardingStatus(user.id);

        return res.status(200).json({
            message: "Login successful",
            onboardingRequired: onboarding.required,
            user: { id: user.id, username: user.username, email: user.email },
        });
    } catch (error) {
        return handleError(res, error, "Sign-in");
    }
});

// Frontend sends the ID token ("credential") from Google Identity Services here.
// Google only proves identity. It never creates an account by itself:
//   - known Google account / known email: signed in; the onboarding gate still
//     blocks the app until date of birth and consents are on file
//   - brand new person: no account and no userId, only a pending identity in the
//     session; the account is created by /auth/onboarding/complete
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

        const user = await findGoogleUser(googleId, email);

        if (!user) {
            await startPendingGoogleSession(req, { googleId, email });

            return res.status(200).json({
                message: "Finish setting up your account",
                isNewUser: true,
                onboardingRequired: true,
                user: null,
            });
        }

        await startSession(req, user.id);

        const onboarding = await getOnboardingStatus(user.id);

        return res.status(200).json({
            message: "Login successful",
            isNewUser: false,
            onboardingRequired: onboarding.required,
            user,
        });
    } catch (error) {
        return handleError(res, error, "Google sign-in");
    }
});

// What the onboarding page needs to render. Works for a pending Google identity
// (no account yet) and for a signed-in account that still has to finish.
router.get("/auth/onboarding", async (req, res) => {
    try {
        const userId = req.session.userId;

        if (userId === undefined) {
            const pending = getPendingGoogle(req);

            if (!pending) {
                return res.status(401).json({ message: "Authentication required" });
            }

            return res.status(200).json({
                required: true,
                needsUsername: true,
                needsDob: true,
                email: pending.email,
            });
        }

        const status = await getOnboardingStatus(userId);

        return res.status(200).json({
            required: status.required,
            needsUsername: false,
            needsDob: status.needsDob,
        });
    } catch (error) {
        return handleError(res, error, "Onboarding status");
    }
});

router.post("/auth/onboarding/complete", async (req, res) => {
    const parsed = completeOnboardingSchema.safeParse(req.body);

    if (!parsed.success) {
        return validationError(res, parsed.error);
    }

    const { username, dateOfBirth } = parsed.data;
    const userId = req.session.userId;

    try {
        /* ---- New Google user: create everything now, in one transaction ---- */
        if (userId === undefined) {
            const pending = getPendingGoogle(req);

            if (!pending) {
                return res.status(401).json({
                    message: "Your sign-in expired. Continue with Google again.",
                });
            }

            if (!username) {
                return fieldError(res, "username", "Choose a username");
            }

            if (!dateOfBirth) {
                return fieldError(res, "dateOfBirth", "Enter your date of birth");
            }

            if (!isAdult(dateOfBirth)) {
                // Nothing was created. Drop the pending identity too.
                await destroySession(req, res);
                return underAge(res);
            }

            // The email and Google id come from the session (verified by Google
            // earlier), never from the request body.
            const newUserId = await createUserWithProfile(
                {
                    username,
                    email: pending.email,
                    googleId: pending.googleId,
                    emailVerified: true,
                },
                { dateOfBirth }
            );

            const user = await getPublicUser(newUserId);

            if (!user) {
                throw new Error("Created user could not be loaded");
            }

            // Regenerates the session, which also drops pendingGoogle.
            await startSession(req, newUserId);

            return res.status(201).json({ message: "Account created", user });
        }

        /* ---- Existing account that has not finished onboarding ---- */
        const status = await getOnboardingStatus(userId);
        const user = await getPublicUser(userId);

        if (!user) {
            await destroySession(req, res);
            return res.status(401).json({ message: "Authentication required" });
        }

        // Nothing to do (for example a second tab submitted the form).
        if (!status.required) {
            req.session.onboardedKey = consentKey;
            return res.status(200).json({ message: "Already complete", user });
        }

        if (status.needsDob) {
            if (!dateOfBirth) {
                return fieldError(res, "dateOfBirth", "Enter your date of birth");
            }

            if (!isAdult(dateOfBirth)) {
                // Nothing is stored for an under-18 answer.
                return underAge(res);
            }
        }

        await db.transaction(async (tx) => {
            // The date of birth is written once and never updated. If the row
            // exists (this account only needs to re-accept), it is left alone.
            if (status.needsDob && dateOfBirth) {
                await tx
                    .insert(accountPrivate)
                    .values({ userId, dateOfBirth })
                    .onConflictDoNothing();
            }

            await tx
                .insert(consents)
                .values(consentRowsFor(userId))
                .onConflictDoNothing();
        });

        req.session.onboardedKey = consentKey;

        return res.status(200).json({ message: "Account ready", user });
    } catch (error) {
        const constraint = uniqueViolation(error);

        if (constraint) {
            const field = fieldFromConstraint(constraint);

            if (field === "username") {
                return res
                    .status(409)
                    .json({ message: "That username is taken", field: "username" });
            }

            return res.status(409).json({
                message:
                    "An account with these details already exists. Try signing in again.",
            });
        }

        return handleError(res, error, "Onboarding");
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

        const onboarding = await getOnboardingStatus(userId);

        return res.status(200).json({
            authenticated: true,
            onboardingRequired: onboarding.required,
            user,
        });
    } catch (error) {
        return handleError(res, error, "Session check");
    }
});

export default router;