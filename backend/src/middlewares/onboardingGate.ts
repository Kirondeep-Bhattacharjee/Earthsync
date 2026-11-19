import type { NextFunction, Request, Response } from "express";
import { consentKey, getOnboardingStatus } from "../lib/onboarding.js";

// Blocks every signed-in user who has not finished onboarding (date of birth
// plus current consents). Mounted once in app.ts, after the auth router, so it
// covers every route registered after it without editing each router.
//
// Requests with no session pass through: each route's own requireAuth answers
// those with 401.
export async function onboardingGate(
    req: Request,
    res: Response,
    next: NextFunction
) {
    const userId = req.session.userId;

    if (userId === undefined) {
        return next();
    }

    // Already verified for these consent versions in this session.
    if (req.session.onboardedKey === consentKey) {
        return next();
    }

    try {
        const status = await getOnboardingStatus(userId);

        if (status.required) {
            return res.status(403).json({
                message: "Finish setting up your account to continue",
                code: "ONBOARDING_REQUIRED",
            });
        }

        req.session.onboardedKey = consentKey;
        return next();
    } catch (error) {
        return next(error);
    }
}