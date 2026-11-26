import { Router } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import { profiles } from "../db/schema.js";
import { requireAuth } from "../middlewares/requireAuth.js";
import { handleError, validationError } from "../lib/http.js";

const router = Router();

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

// Only the settings that exist today. A future setting is added here and in
// the two handlers below.
const updateSettingsSchema = z.object({
    readReceipts: z.boolean(),
});

/* ------------------------------------------------------------------ */
/* Read                                                                */
/* ------------------------------------------------------------------ */

// My settings. readReceipts maps to profiles.show_read_receipts: when it is off
// (for me or for the other person in a chat), neither of us sees the other's
// "read" state. The rule itself lives in lib/receipts.ts (receiptsMutual).
router.get("/settings", requireAuth, async (req, res) => {
    const viewerId = req.session.userId;

    if (viewerId === undefined) {
        return res.status(401).json({ message: "Not authenticated" });
    }

    try {
        const [row] = await db
            .select({ readReceipts: profiles.showReadReceipts })
            .from(profiles)
            .where(eq(profiles.userId, viewerId))
            .limit(1);

        if (!row) {
            return res.status(404).json({ message: "Profile not found" });
        }

        return res.json({ readReceipts: row.readReceipts });
    } catch (error) {
        return handleError(res, error, "Get settings");
    }
});

/* ------------------------------------------------------------------ */
/* Update                                                              */
/* ------------------------------------------------------------------ */

// Saves my settings and returns the saved values, so the client shows what the
// server actually stored. Only my own row can change: the id comes from the
// session, never from the request.
router.patch("/settings", requireAuth, async (req, res) => {
    const viewerId = req.session.userId;

    if (viewerId === undefined) {
        return res.status(401).json({ message: "Not authenticated" });
    }

    const parsed = updateSettingsSchema.safeParse(req.body);

    if (!parsed.success) {
        return validationError(res, parsed.error);
    }

    try {
        const [row] = await db
            .update(profiles)
            .set({ showReadReceipts: parsed.data.readReceipts })
            .where(eq(profiles.userId, viewerId))
            .returning({ readReceipts: profiles.showReadReceipts });

        if (!row) {
            return res.status(404).json({ message: "Profile not found" });
        }

        return res.json({ readReceipts: row.readReceipts });
    } catch (error) {
        return handleError(res, error, "Update settings");
    }
});

export default router;