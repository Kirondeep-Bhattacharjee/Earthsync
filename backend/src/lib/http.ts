import type { Response } from "express";
import { z } from "zod";

export class HttpError extends Error {
    status: number;

    constructor(status: number, message: string) {
        super(message);
        this.status = status;
    }
}

export function validationError(res: Response, error: z.ZodError) {
    return res.status(400).json({
        message: "Invalid input",
        errors: error.issues.map((issue) => ({
            field: issue.path.join("."),
            message: issue.message,
        })),
    });
}

// Returns the violated constraint name for a Postgres unique violation (23505),
// or null if the error is something else. Checks `cause` because newer Drizzle
// versions wrap driver errors.


export function handleError(res: Response, error: unknown, label: string) {
    if (error instanceof HttpError) {
        return res.status(error.status).json({ message: error.message });
    }

    console.error(`${label} error:`, error);
    return res
        .status(500)
        .json({ message: "An internal server error occurred" });
}

// Returns the violated constraint name for a Postgres unique violation (23505),
// or null if the error is something else. Checks `cause` because newer Drizzle
// versions wrap driver errors.
export function uniqueViolation(error: unknown): string | null {
    const e = error as {
        code?: string;
        constraint?: string;
        cause?: { code?: string; constraint?: string };
    };

    const code = e?.code ?? e?.cause?.code;
    if (code !== "23505") {
        return null;
    }

    return e?.constraint ?? e?.cause?.constraint ?? "unknown";
}