import { z } from "zod";

// Keep this file identical in backend/src/lib/dob.ts and SoloMusic/src/lib/dob.ts.

export const MIN_AGE = 18;

const DOB_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

type Parts = { year: number; month: number; day: number };

function parseDob(value: string): Parts | null {
    if (!DOB_PATTERN.test(value)) {
        return null;
    }

    const [year, month, day] = value.split("-").map(Number) as [
        number,
        number,
        number,
    ];
    const date = new Date(Date.UTC(year, month - 1, day));

    // Rejects 2000-02-30 and similar: JS silently rolls those over.
    if (
        date.getUTCFullYear() !== year ||
        date.getUTCMonth() !== month - 1 ||
        date.getUTCDate() !== day
    ) {
        return null;
    }

    return { year, month, day };
}

// Whole years of age on the given day (UTC), or null if the date is not valid.
export function ageOn(dob: string, today: Date = new Date()): number | null {
    const parts = parseDob(dob);

    if (!parts) {
        return null;
    }

    let age = today.getUTCFullYear() - parts.year;
    const month = today.getUTCMonth() + 1;
    const beforeBirthday =
        month < parts.month || (month === parts.month && today.getUTCDate() < parts.day);

    if (beforeBirthday) {
        age -= 1;
    }

    return age;
}

// Format and plausibility only. The under-18 decision is isAdult() below, so the
// server can treat it as its own outcome (rejection, later a lockout).
export const dobSchema = z
    .string()
    .trim()
    .refine((value) => parseDob(value) !== null, "Enter a valid date of birth")
    .refine((value) => {
        const age = ageOn(value);
        return age !== null && age >= 0;
    }, "Date of birth cannot be in the future")
    .refine((value) => {
        const age = ageOn(value);
        return age !== null && age <= 120;
    }, "Enter a valid date of birth");

export function isAdult(dob: string, today: Date = new Date()): boolean {
    const age = ageOn(dob, today);
    return age !== null && age >= MIN_AGE;
}