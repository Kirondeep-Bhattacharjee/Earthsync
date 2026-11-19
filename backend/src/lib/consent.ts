import { z } from "zod";

// Bump a version when the document behind that checkbox changes in a way users
// must re-accept. Anyone without a consents row at the new version is sent back
// through onboarding.
export const CURRENT_CONSENT_VERSIONS = {
    age_confirmation: "1",
    terms_privacy: "2026-11-19", // bump when the Terms or the Privacy Policy changes
} as const;

export type ConsentKind = keyof typeof CURRENT_CONSENT_VERSIONS;

// Request body fields, one per checkbox. Both must be literally true, so an
// omitted or false box fails validation.
export const consentFieldsSchema = z.object({
    confirmedAdult: z.literal(true, { error: "You must confirm you are 18 or older" }),
    acceptedTerms: z.literal(true, {
        error: "You must accept the Terms of Service and Privacy Policy",
    }),
});

// The rows to insert for one onboarding submission: one per checkbox.
export function consentRowsFor(userId: number) {
    return (Object.keys(CURRENT_CONSENT_VERSIONS) as ConsentKind[]).map((kind) => ({
        userId,
        kind,
        version: CURRENT_CONSENT_VERSIONS[kind],
    }));
}