import "express-session";

declare module "express-session" {
    interface SessionData {
        userId: number;
        // A verified Google identity whose account does not exist yet. Set by
        // /auth/google for new users, consumed by /auth/onboarding/complete.
        pendingGoogle: {
            googleId: string;
            email: string;
            expiresAt: number; // ms since epoch
        };
        // Cached "this user has finished onboarding at these consent versions",
        // so the gate does not query the database on every request.
        onboardedKey: string;
    }
}