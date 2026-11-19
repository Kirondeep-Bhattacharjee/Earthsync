import { randomBytes } from "node:crypto";
import { z } from "zod";

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

// One rule for every place a username is typed: sign-up, profile edits and
// the /u/:username lookup. Lowercasing here is what makes "Sam" and "sam" the
// same name, so the unique constraint on profiles.username is case-insensitive
// in practice.
export const usernameSchema = z
    .string()
    .trim()
    .toLowerCase()
    .regex(
        /^[a-z0-9_]{3,30}$/,
        "Username must be 3-30 characters: letters, numbers and underscores only"
    );

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

// Default name for accounts that did not pick one (Google sign-up). Random on
// purpose: nothing about the person or their email may appear in a public name.
export function generateUsername(): string {
    return `user_${randomBytes(4).toString("hex")}`;
}