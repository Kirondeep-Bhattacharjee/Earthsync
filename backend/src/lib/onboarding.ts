import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { accountPrivate, consents } from "../db/schema.js";
import { CURRENT_CONSENT_VERSIONS, type ConsentKind } from "./consent.js";

// Changes whenever any consent version changes. The gate caches it in the
// session, so a version bump makes every cached value stale at once.
export const consentKey = Object.entries(CURRENT_CONSENT_VERSIONS)
    .map(([kind, version]) => `${kind}:${version}`)
    .join("|");

export type OnboardingStatus = {
    needsDob: boolean; // no account_private row yet
    consentsOk: boolean; // every consent exists at its current version
    required: boolean; // needsDob || !consentsOk
};

// The single definition of "this account may use the app". Used by the HTTP
// gate, /auth/me, the onboarding endpoints and the WebSocket upgrade.
export async function getOnboardingStatus(userId: number): Promise<OnboardingStatus> {
    const [dob] = await db
        .select({ userId: accountPrivate.userId })
        .from(accountPrivate)
        .where(eq(accountPrivate.userId, userId))
        .limit(1);

    const rows = await db
        .select({ kind: consents.kind, version: consents.version })
        .from(consents)
        .where(eq(consents.userId, userId));

    const consentsOk = (Object.keys(CURRENT_CONSENT_VERSIONS) as ConsentKind[]).every(
        (kind) =>
            rows.some(
                (row) =>
                    row.kind === kind &&
                    row.version === CURRENT_CONSENT_VERSIONS[kind]
            )
    );

    return {
        needsDob: !dob,
        consentsOk,
        required: !dob || !consentsOk,
    };
}